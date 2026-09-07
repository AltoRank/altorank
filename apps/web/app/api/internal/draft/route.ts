/**
 * Write exactly one draft, in its own invocation.
 *
 * Server-to-server only, authenticated with CRON_SECRET like the cron routes:
 * the callers are `fanOutDrafts` (the rest of the week) and the onboarding
 * worker (the first draft), neither of which has a user session to forward.
 * See lib/content/fan-out.ts for why this exists at all - briefly, a draft
 * costs 103s against a 300s function, so the way to write seven quickly is
 * seven invocations rather than one longer one.
 *
 * One draft per request, never a loop. That is the whole point: the budget is
 * per invocation, and a loop here would rebuild the bottleneck it removes.
 *
 * With `runId` this is the last leg of an onboarding run: the worker chose the
 * keyword and passed the gates, and this writes the draft and stamps the run's
 * row - research done, then the article and the terminal status - so the
 * progress screen, which polls the row, sees "Wrote 1,240 words on X" the
 * moment it is true. The stamp is guarded on the row still being `running`,
 * so a run the start route has since closed as stale is not reopened.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { generateArticle } from "@/lib/content/generate";
import { fulfilPlannedEntry } from "@/lib/onboarding/plan";
import { getQuota, quotaExceededMessage } from "@/lib/billing/quota";
import { authorised } from "@/lib/content/fan-out";
import { stampRun } from "@/lib/onboarding/run-store";
import type { OnboardingEvent } from "@/lib/onboarding/events";

export const maxDuration = 300;

interface Body {
  workspaceId?: string;
  keywordId?: string | null;
  keyword?: string;
  /** The onboarding run this is the first draft of. */
  runId?: string;
  selection?: { reasons: string[]; score: number; difficulty: number | null; volume: number | null };
}

export async function POST(request: NextRequest) {
  if (!authorised(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { workspaceId, keyword, runId, selection } = body;
  const keywordId = body.keywordId ?? null;
  // The fan-out always names a plan entry; the first draft of a run may not
  // have one (a keyword recommended but not planned) and is keyed by the run.
  if (!workspaceId || !keyword || (!keywordId && !runId)) {
    return NextResponse.json(
      { error: "workspaceId, keyword and keywordId (or runId) are required" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();
  const stamp = (event: OnboardingEvent, opts?: Parameters<typeof stampRun>[3]) =>
    runId ? stampRun(supabase, runId, event, opts) : Promise.resolve(false);

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id, agency_id")
    .eq("id", workspaceId)
    .maybeSingle();
  if (!workspace) {
    await stamp({ phase: "drafting", status: "failed", detail: "The workspace no longer exists." }, { finish: true });
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  // The same gate the cron and the onboarding pipeline use. Six requests go out
  // at once and each checks independently, so a burst cannot spend more than
  // the entitlement: the last ones to arrive find nothing remaining.
  const quota = await getQuota(supabase, workspace.agency_id as string);
  if (quota.limit !== null && (quota.remaining ?? 0) <= 0) {
    await stamp({ phase: "drafting", status: "skipped", detail: quotaExceededMessage(quota) }, { finish: true });
    return NextResponse.json({ status: "skipped", reason: "quota" }, { status: 200 });
  }

  // Idempotence, and the reason it matters: a retried dispatch, or the cron
  // reaching the same entry first, must not produce a second article for one
  // planned day. An entry that already carries an article_id is done.
  const { data: entry } = keywordId
    ? await supabase
        .from("calendar_entries")
        .select("id, article_id")
        .eq("workspace_id", workspaceId)
        .eq("keyword_id", keywordId)
        .is("article_id", null)
        .maybeSingle()
    : { data: null };
  if (!entry && !runId) {
    return NextResponse.json({ status: "skipped", reason: "already-written" }, { status: 200 });
  }

  try {
    const result = await generateArticle({
      supabase,
      workspaceId,
      keyword,
      keywordId: keywordId ?? undefined,
      autonomous: true,
      selection,
      billToAgencyId: workspace.agency_id as string,
      // The one boundary inside the draft: research is done, the model is
      // about to write. The same sentence the inline pipeline emits, so the
      // screen reads identically whichever invocation wrote the draft.
      onResearch: runId
        ? (research) =>
            void stamp({
              phase: "drafting",
              status: "active",
              detail:
                `Read ${research.competitors.length} ranking page${research.competitors.length === 1 ? "" : "s"}` +
                ` and ${research.peopleAlsoAsk.length} question${research.peopleAlsoAsk.length === 1 ? "" : "s"} people ask. Writing now.`,
            })
        : undefined,
    });
    if (entry) await fulfilPlannedEntry(supabase, entry.id as string, result.articleId);
    await stamp(
      {
        phase: "drafting",
        status: "done",
        detail: `Wrote ${result.wordCount.toLocaleString()} words on "${keyword}".`,
      },
      {
        finish: true,
        article: {
          id: result.articleId,
          title: result.title,
          keyword,
          wordCount: result.wordCount,
          verdict: result.factCheck.verdict,
        },
      },
    );
    return NextResponse.json(
      { status: "generated", articleId: result.articleId, wordCount: result.wordCount },
      { status: 200 },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await stamp({ phase: "drafting", status: "failed", detail }, { finish: true });
    return NextResponse.json({ status: "error", error: detail }, { status: 500 });
  }
}
