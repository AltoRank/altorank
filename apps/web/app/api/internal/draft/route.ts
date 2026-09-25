/**
 * Write exactly one draft, in its own invocation.
 *
 * Server-to-server only, authenticated with CRON_SECRET like the cron routes:
 * the callers are the onboarding worker (the first draft) and the trial resume
 * (the rest of the week, lib/plan/resume-week.ts), neither of which has a user
 * session to forward. See lib/content/fan-out.ts for why this exists at all -
 * briefly, a draft costs 103s against a 300s function, so the way to write
 * several quickly is several invocations rather than one longer one.
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
 *
 * The "your draft is ready" email goes from here too, straight after that
 * stamp, because this is the one place that knows the draft is ready. It used
 * to be chained onto the worker's wait for this request, inside a worker
 * whose own budget the pipeline had mostly spent; when the platform cut the
 * worker off the email waited for cron/generate's sweep, and a real signup
 * (2026-09-22) read "your draft is ready" 42 minutes after the draft existed.
 *
 * With `entryId` and `claim` this is one entry of a resumed week: the resume
 * claimed the entry for `claim` (lib/plan/draft-claim.ts) and this writes it
 * only while that claim still stands, so a duplicated request or a second
 * delivery of the Stripe event writes nothing. When it is done, well or
 * badly, it starts the week's next draft, and the last one to land sends the
 * one email for the batch.
 */
import { NextRequest, NextResponse, after } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { generateArticle } from "@/lib/content/generate";
import { fulfilPlannedEntry } from "@/lib/onboarding/plan";
import { getQuota, quotaExceededMessage } from "@/lib/billing/quota";
import { trialHoldReason } from "@/lib/billing/trial-hold";
import { authorised } from "@/lib/content/fan-out";
import { stampRun } from "@/lib/onboarding/run-store";
import { announceDraftBatch } from "@/lib/email/draft-batch";
import { recordEntryFailure } from "@/lib/plan/draft-claim";
import { continueFrom } from "@/lib/plan/resume-week";
import type { OnboardingEvent } from "@/lib/onboarding/events";
import type { RelatedKeyword } from "@/lib/seo/brief-data";
import type { SupabaseClient } from "@supabase/supabase-js";

export const maxDuration = 300;

interface Body {
  workspaceId?: string;
  keywordId?: string | null;
  keyword?: string;
  /** The onboarding run this is the first draft of. */
  runId?: string;
  /** The planned entry a resumed week claimed, and the claim it holds. */
  entryId?: string;
  claim?: string;
  /** The last day of the week the resume started, so the chain stays in it. */
  until?: string;
  selection?: { reasons: string[]; score: number; difficulty: number | null; volume: number | null };
  /**
   * This draft's share of the run's one related-keyword lookup, when the
   * dispatcher bought the week in a single task (lib/content/fan-out.ts).
   * Absent means nobody looked and this draft buys its own.
   */
  relatedKeywords?: RelatedKeyword[];
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
  // A resumed entry is named by its id and its claim, both or neither.
  const claimed = body.entryId && body.claim ? { entryId: body.entryId, by: body.claim } : null;
  // The fan-out always names a plan entry; the first draft of a run may not
  // have one (a keyword recommended but not planned) and is keyed by the run.
  if (!workspaceId || !keyword || (!keywordId && !runId && !claimed) || Boolean(body.entryId) !== Boolean(body.claim)) {
    return NextResponse.json(
      { error: "workspaceId, keyword and keywordId (or runId, or entryId with claim) are required" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();
  const stamp = (event: OnboardingEvent, opts?: Parameters<typeof stampRun>[3]) =>
    runId ? stampRun(supabase, runId, event, opts) : Promise.resolve(false);

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id, account_id")
    .eq("id", workspaceId)
    .maybeSingle();
  if (!workspace) {
    await stamp({ phase: "drafting", status: "failed", detail: "The workspace no longer exists." }, { finish: true });
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  // Idempotence first, before any gate is asked: a request that does not hold
  // the entry it names - a duplicate, or one whose claim was handed to
  // another writer - must not record anything against somebody else's claim.
  const { data: entry } = claimed
    ? await supabase
        .from("calendar_entries")
        .select("id, article_id")
        .eq("id", claimed.entryId)
        .eq("workspace_id", workspaceId)
        .eq("draft_claimed_by", claimed.by)
        .is("article_id", null)
        .is("draft_failed_at", null)
        .maybeSingle()
    : keywordId
      ? await supabase
          .from("calendar_entries")
          .select("id, article_id")
          .eq("workspace_id", workspaceId)
          .eq("keyword_id", keywordId)
          .is("article_id", null)
          .maybeSingle()
      : { data: null };
  // A retried dispatch, or the cron reaching the same entry first, must not
  // produce a second article for one planned day. An entry that already
  // carries an article_id is done.
  if (!entry && !runId) {
    return NextResponse.json({ status: "skipped", reason: claimed ? "not-claimed" : "already-written" }, { status: 200 });
  }

  // What a resumed entry does once it is settled either way: hand the week
  // its next draft, and, when this was the last one, send the batch's email.
  const next = (): void => {
    if (claimed) after(() => chainNext(supabase, workspaceId, claimed.by, body.until));
  };

  // The same gates the cron and the onboarding pipeline use. The trial hold
  // first (lib/billing/trial-hold.ts): the onboarding's own first draft
  // passes it, anything after it waits for the trial, in the hold's words.
  const quota = await getQuota(supabase, workspace.account_id as string);
  const refusal = trialHoldReason(quota) ?? (quota.limit !== null && (quota.remaining ?? 0) <= 0 ? quotaExceededMessage(quota) : null);
  if (refusal) {
    await stamp({ phase: "drafting", status: "skipped", detail: refusal }, { finish: true });
    if (claimed) await recordEntryFailure(supabase, claimed.entryId, claimed.by, refusal);
    next();
    return NextResponse.json({ status: "skipped", reason: trialHoldReason(quota) ? "trial-hold" : "quota" }, { status: 200 });
  }

  try {
    const result = await generateArticle({
      supabase,
      workspaceId,
      keyword,
      keywordId: keywordId ?? undefined,
      autonomous: true,
      selection,
      relatedKeywords: Array.isArray(body.relatedKeywords) ? body.relatedKeywords : undefined,
      billToAccountId: workspace.account_id as string,
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
    // The run's draft is ready the moment the row says so, and the email
    // says so at the same moment. Whether or not the stamp took - a run the
    // start route closed as stale still has a real draft in review.
    // `announceDraftBatch` never throws.
    if (runId) await announceDraftBatch(supabase, workspaceId);
    next();
    return NextResponse.json(
      { status: "generated", articleId: result.articleId, wordCount: result.wordCount },
      { status: 200 },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await stamp({ phase: "drafting", status: "failed", detail }, { finish: true });
    // On the calendar, in words, and handed back: the next scheduled run
    // takes an entry whose draft failed whatever its date.
    if (claimed) await recordEntryFailure(supabase, claimed.entryId, claimed.by, detail);
    next();
    return NextResponse.json({ status: "error", error: detail }, { status: 500 });
  }
}

/**
 * Start the week's next draft, and when nothing is left in flight, tell the
 * account about the batch. Never throws: this runs after the response, and
 * whatever it cannot do the scheduled writer and the draft sweep pick up.
 */
async function chainNext(supabase: SupabaseClient, workspaceId: string, by: string, until: string | undefined): Promise<void> {
  try {
    const step = await continueFrom(supabase, workspaceId, { by, until });
    if (step.done) await announceDraftBatch(supabase, workspaceId);
    await step.settled;
  } catch (err) {
    console.error(`[internal/draft] could not start the next draft for ${workspaceId}: ${err instanceof Error ? err.message : err}`);
  }
}
