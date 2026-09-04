import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import { anthropicModel } from "@/lib/ai/models";
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
// Events: plan → chunk* → complete { html, changes } | error.

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
  if (!articleId || !html?.trim() || !instruction?.trim()) {
    return Response.json({ error: "articleId, html and instruction are required" }, { status: 400 });
  }
  if (html.length > 400_000) {
    return Response.json({ error: "Article too large to rewrite in one pass" }, { status: 413 });
  }

  // RLS decides whether this user can read the article; a miss is a 404.
  const { data: article } = await supabase
    .from("articles")
    .select("id, title, keyword")
    .eq("id", articleId)
    .single();
  if (!article) {
    return Response.json({ error: "Article not found" }, { status: 404 });
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
        const run = client.messages.stream({
          model: anthropicModel("content"),
          // The whole article back plus three bullets. Same reasoning as the
          // generator's ceiling: a truncated rewrite must fail, not be offered.
          max_tokens: 24_000,
          system,
          messages: [{ role: "user", content: userPrompt }],
        });

        let raw = "";
        for await (const event of run) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            raw += event.delta.text;
            send({ type: "chunk", text: event.delta.text });
          }
        }
        const final = await run.finalMessage();
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
        send({ type: "error", error: err instanceof Error ? err.message : "Rewrite failed" });
      } finally {
        controller.close();
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
