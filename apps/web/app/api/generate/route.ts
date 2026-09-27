import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { generateArticle } from "@/lib/content/generate";
import { sessionTrialGate } from "@/lib/billing/body-lock";
import { trialRefusal } from "@/lib/billing/trial-refusal";
import { trialHoldReason } from "@/lib/billing/trial-hold";
import { getRequestQuota } from "@/lib/queries/quota";

// ---------------------------------------------------------------------------
// POST /api/generate — stream AI article generation via SSE
// ---------------------------------------------------------------------------
//
// Auth and transport only. The generation itself lives in lib/content/generate
// so that this route and the unattended cron cannot drift apart; the streaming
// callback is the only thing that differs between them.

export async function POST(request: NextRequest) {
  // --- Auth ----------------------------------------------------------------
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // --- Parse body ----------------------------------------------------------
  let body: { workspaceId: string; keyword: string; title?: string; articleId?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { workspaceId, keyword, title, articleId } = body;

  if (!workspaceId || !keyword) {
    return new Response(
      JSON.stringify({ error: "workspaceId and keyword are required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // --- Authorise the workspace ---------------------------------------------
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id, account_id")
    .eq("id", workspaceId)
    .single();

  if (!workspace) {
    return new Response(JSON.stringify({ error: "Workspace not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { data: membership } = await supabase
    .from("account_members")
    .select("id")
    .eq("account_id", workspace.account_id)
    .eq("user_id", user.id)
    .single();

  if (!membership) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  // This route streams the article as it is written, so it is a way to read
  // a body as much as a way to write one. An account that has not started
  // its trial does neither (lib/billing/trial.ts, draftBodyLocked), and is
  // told which of the two it asked for in the words every other door uses
  // (lib/billing/trial-refusal.ts): a new keyword is another draft, which
  // the hold refuses as the agent API, Write now and the crons do; writing
  // into an open draft is its text, which the lock refuses as the editor
  // does. A new keyword the hold would still allow (the first article is not
  // written yet) is refused for the text the stream would show.
  const accountId = workspace.account_id as string;
  const email = user.email ?? null;
  if ((await sessionTrialGate(accountId, email)) === "gated") {
    const held = !articleId && trialHoldReason(await getRequestQuota(accountId, email)) !== null;
    return new Response(JSON.stringify({ error: trialRefusal(held ? "draft" : "body"), reason: "trial_required" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  // --- Stream ---------------------------------------------------------------
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      try {
        send({ type: "researching" });

        const result = await generateArticle({
          supabase,
          workspaceId,
          keyword,
          title,
          // Present when the editor is generating into the draft it has open.
          // Absent for the "new article" modal, which wants a new row.
          articleId,
          onResearch: (research) =>
            send({
              type: "research",
              intent: research.intent.intent,
              confidence: research.intent.confidence,
              competitors: research.competitors.length,
              questions: research.peopleAlsoAsk.length,
              relatedKeywords: research.relatedKeywords.length,
              targetWordCount: research.recommendedWordCount,
              layers: research.layers,
            }),
          onChunk: (html) => send({ type: "chunk", html }),
        });

        // `start` is emitted after the fact rather than before generation
        // begins: the ids are created inside the core, and inventing a
        // placeholder here would give the client an id that never resolves.
        send({ type: "start", articleId: result.articleId, jobId: result.jobId });

        send({
          type: "factcheck",
          verdict: result.factCheck.verdict,
          summary: result.factCheck.summary,
          counts: result.factCheck.counts,
        });

        send({
          type: "complete",
          articleId: result.articleId,
          title: result.title,
          wordCount: result.wordCount,
          tokensUsed: result.tokensUsed,
          factCheckVerdict: result.factCheck.verdict,
          claimsToReview: result.factCheck.counts.total,
        });

        controller.close();
      } catch (err) {
        send({
          type: "error",
          error: err instanceof Error ? err.message : "Unknown generation error",
        });
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
