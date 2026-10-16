import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import { canSpend } from "@/lib/billing/spend-gate";
import { sessionBodyLockedForWorkspace } from "@/lib/billing/body-lock";
import { BODY_LOCKED_MESSAGE } from "@/lib/billing/trial-refusal";
import { takeDoor } from "@/lib/billing/spend-doors";
import { withSpendScope } from "@/lib/billing/spend-scope";
import { readArticlesWhole } from "@/lib/articles/body-read";
import { tiptapToHtml } from "@/lib/cms/html";
import { anthropicModel } from "@/lib/ai/models";
import { MAX_INSTRUCTION_CHARS, REWRITE_HARD_CEILING_CHARS, rewriteSizeLimit } from "@/lib/editor/rewrite-limits";
import { streamMetered } from "@/lib/ai/metered";
import {
  buildRewriteArticlePrompt,
  parseRewriteArticleResponse,
  keepsAssets,
  REWRITE_PLAN_LINE,
} from "@/lib/ai/micro";

// ---------------------------------------------------------------------------
// POST /api/editor/rewrite — stream a whole-article rewrite as a proposal
// ---------------------------------------------------------------------------
//
// Not /api/generate. That route researches a keyword, writes from scratch and
// stores the result into the article as it finishes, which is right for a
// draft and wrong for "tighten this". A rewrite starts from the text on
// screen, follows one instruction, and must be stored nowhere: the editor
// holds it in state until the person presses "Replace article", and Save is
// what writes. This route therefore reads the article for authorisation and
// context only, and never updates it.
//
// Events: plan → progress* → complete { html, changes } | error.
//
// What it costs is bounded four ways. The text sent may be the saved
// article's size with room for unsaved edits, not any size the caller likes
// (rewriteSizeLimit). The instruction is a sentence, not a second article.
// Each press is counted per account (lib/billing/spend-doors.ts). And the
// call is metered: claimed under a spend scope and written to provider_spend
// with what the provider reported, including a stream cut short.
//
// The model's text is not sent back as it arrives. The editor only ever
// counted the words, so it gets the count; the HTML leaves this route once,
// parsed and checked (keepsAssets), in `complete`.

/** Send a progress count at most once per this many characters of model text. */
const PROGRESS_EVERY_CHARS = 1_500;

const wordCount = (html: string) => html.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { articleId?: string; html?: string; instruction?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { articleId, html, instruction } = body;
  if (typeof articleId !== "string" || typeof html !== "string" || typeof instruction !== "string" || !articleId || !html.trim() || !instruction.trim()) {
    return Response.json({ error: "articleId, html and instruction are required" }, { status: 400 });
  }
  if (instruction.length > MAX_INSTRUCTION_CHARS) {
    return Response.json({ error: `Keep the instruction under ${MAX_INSTRUCTION_CHARS.toLocaleString("en")} characters.` }, { status: 400 });
  }
  if (html.length > REWRITE_HARD_CEILING_CHARS) {
    return Response.json({ error: "Article too large to rewrite in one pass" }, { status: 413 });
  }

  // RLS decides whether this user can read the article; a miss is a 404.
  const { data: article } = await supabase
    .from("articles")
    .select("id, title, keyword, workspace_id")
    .eq("id", articleId)
    .single();
  if (!article) {
    return Response.json({ error: "Article not found" }, { status: 404 });
  }

  // The editor is what the trial opens, and this route is the editor's: it
  // takes the article's text and hands a rewrite of it back. The editor's AI
  // actions refused a gated account (app/actions/editor-ai.ts) and this one
  // did not, so the body lock is asked here the same way.
  if (await sessionBodyLockedForWorkspace(article.workspace_id as string)) {
    return Response.json({ error: BODY_LOCKED_MESSAGE, reason: "trial_required" }, { status: 403 });
  }

  // Billed to the article's account, read through the person's client so RLS
  // answers it: this route used to take the oldest membership, which for
  // someone in two accounts asked the wrong one's plan.
  const { data: site } = await supabase
    .from("workspaces")
    .select("account_id")
    .eq("id", article.workspace_id)
    .maybeSingle();
  if (!site?.account_id) {
    return Response.json({ error: "No account membership" }, { status: 403 });
  }
  const accountId = site.account_id as string;
  const workspaceId = article.workspace_id as string;
  const gate = await canSpend(supabase, accountId, {
    userEmail: user.email ?? undefined,
    workspaceId,
    action: "draft",
  });
  if (!gate.allowed) {
    // 402 and the sentence, not a silent empty stream: the editor renders
    // `error` from this response verbatim.
    return Response.json({ error: gate.message, reason: gate.reason }, { status: 402 });
  }

  // The text on screen, sized against the text saved. Read with the service
  // role only now that the caller's client has shown the row and the lock
  // has answered (lib/articles/body-read.ts).
  const [saved] = await readArticlesWhole<{ content: Record<string, unknown> | null }>([articleId], "content");
  const savedChars = saved?.content ? tiptapToHtml(saved.content).length : 0;
  if (html.length > rewriteSizeLimit(savedChars)) {
    return Response.json(
      { error: "This is much longer than the saved article. Save your changes, then ask for the rewrite again." },
      { status: 413 },
    );
  }

  // Counted per account, trial included. Self-host pays its own bills and
  // the operator's account is ours: neither is counted.
  if (gate.reason !== "self-host" && gate.reason !== "operator") {
    const door = await takeDoor("editor-rewrite", { accountId, workspaceId });
    if (!door.allowed) {
      return Response.json({ error: door.message, reason: "rate_limited" }, { status: 429 });
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };
      try {
        send({ type: "plan", text: REWRITE_PLAN_LINE });

        const { system, user: userPrompt } = buildRewriteArticlePrompt({
          html,
          instruction,
          context: { title: article.title, keyword: article.keyword },
        });
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        let raw = "";
        let sentAt = 0;
        const final = await withSpendScope({ workspaceId, articleId }, () =>
          streamMetered(
            client,
            {
              model: anthropicModel("content"),
              // The whole article back plus three bullets. Same reasoning as the
              // generator's ceiling: a truncated rewrite must fail, not be offered.
              max_tokens: 24_000,
              system,
              messages: [{ role: "user", content: userPrompt }],
            },
            "editor/rewrite",
            (text) => {
              raw += text;
              if (raw.length - sentAt >= PROGRESS_EVERY_CHARS) {
                sentAt = raw.length;
                send({ type: "progress", words: wordCount(raw) });
              }
            },
            // A reader that goes away stops the model, and the row is written
            // for what it produced until then.
            { signal: request.signal },
          ),
        );
        if (final.stop_reason === "max_tokens") {
          throw new Error("The rewrite hit the token ceiling before it finished, so nothing is proposed.");
        }

        const parsed = parseRewriteArticleResponse(raw);
        if (!parsed.html.trim()) throw new Error("The model returned no article");
        if (!keepsAssets(html, parsed.html)) {
          throw new Error("The rewrite dropped a link or image, so it was not proposed. Try a narrower instruction.");
        }

        send({
          type: "complete",
          html: parsed.html,
          changes: parsed.changes,
          inputTokens: final.usage?.input_tokens ?? 0,
          outputTokens: final.usage?.output_tokens ?? 0,
        });
      } catch (err) {
        try {
          send({ type: "error", error: err instanceof Error ? err.message : "Rewrite failed" });
        } catch {
          // The reader is gone; there is no one to tell.
        }
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed by a reader that went away.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
