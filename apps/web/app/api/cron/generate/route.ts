import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cron-auth";
import { createServiceClient } from "@/lib/supabase/server";
import { recommendKeywords, pickNextKeyword } from "@/lib/seo/recommendations";
import { closeCoveredEntries, duePlannedKeyword, fulfilPlannedEntry } from "@/lib/onboarding/plan";
import { profileIsUsable } from "@/lib/seo/topical-profile";
import { getQuota, quotaExceededMessage } from "@/lib/billing/quota";
import { firstDraftAwaitsReview } from "@/lib/billing/first-draft-gate";
import { canSpend } from "@/lib/billing/spend-gate";
import { resumeExpiredPauses } from "@/lib/billing/resume";
import { billingEnabled, getStripe } from "@/lib/stripe";
import { generateArticle, ConcurrentGenerationError } from "@/lib/content/generate";
import { sweepStaleDrafts } from "@/lib/content/stale-drafts";
import { PAID_DEFAULT_PACE } from "@/lib/content/pace";
import { describePaceBudget, readPaceBudget } from "@/lib/plan/pace-budget";
import { readFrozenEntries } from "@/lib/plan/frozen";
import { accountRecipients } from "@/lib/email/account-recipients";
import { sendArticleDraftedEmails } from "@/lib/email/article-emails";
import { sweepUnannouncedDrafts } from "@/lib/email/draft-batch";
import { describeSendOutcome } from "@/lib/email/send-once";
import { getDestinations } from "@/lib/publishing/destinations";
import { holdUrl } from "@/lib/publishing/hold-link";
import {
  announceNothingWritten,
  announcePausedSites,
  announceSetupUnfinished,
  nothingWrittenReason,
  remindEndingPauses,
  sweepUnfinishedSetups,
} from "@/lib/email/schedule-events";
import {
  orderByStaleness,
  latestPerWorkspace,
  MAX_ARTICLES_PER_RUN,
  roomForAnother,
} from "@/lib/content/generate-queue";
import { observedCron } from "@/lib/observability/cron";

/**
 * Scheduled draft generation.
 *
 *   GET /api/cron/generate    header: x-cron-secret
 *
 * For each workspace that has opted in, picks the highest-scoring keyword from
 * the recommendation queue and writes a draft into `review`.
 *
 * It does not publish, and there is no flag to make it publish. The approval
 * gate is what separates this from a content farm, and the moment a machine can
 * both choose a topic and put it on a client's site unreviewed, the gate is
 * decorative.
 *
 * Three things bound the damage a misconfiguration can do:
 *
 *   opt-in         `workspaces.auto_generate` defaults false, so this spends
 *                  nobody's API budget until they ask
 *   weekly limit   counted from articles actually written, so retries and a
 *                  too-frequent schedule cannot run up a bill
 *   quality filter `pickNextKeyword` refuses provider noise, so an unattended
 *                  run will not write "S Eo: A Complete Guide"
 *
 * Runs one workspace at a time on purpose. Generation is a long model call, and
 * a serverless invocation that fans out across every workspace at once is the
 * one most likely to hit a wall-clock timeout halfway through and leave rows in
 * `drafting`.
 *
 * That caution had become a price. One article per workspace per run, once a
 * day, capped a site near 30 a month against a plan sold as 100 - and made
 * `auto_generate_weekly_limit` a setting a customer could raise past anything
 * the schedule could deliver, since a daily run can never write more than
 * seven in a week. The ceiling was a five-minute function, not a view about
 * how often a site should publish.
 *
 * So: four runs a day, and an explicit ceiling on how much any one invocation
 * will do. Those go together - a bound per run is what makes running more often
 * safe, and frequent runs are what make the bound cheap, because whatever is
 * left waits six hours rather than a day.
 *
 * The four runs are not all in vercel.json. The Vercel account is on Hobby,
 * which rejects any cron expression firing more than once a day - the
 * deployment fails outright, so `0 1,7,13,19 * * *` here is not an option
 * without a Pro upgrade. Vercel keeps the 07:00 run; .github/workflows/
 * generate-cron.yml calls this same endpoint at 01/13/19 UTC with the same
 * secret. One code path, two schedulers.
 *
 * If that workflow is not armed (its secret is unset), this route still behaves
 * exactly as it did - once a day, bounded. Nothing here depends on the extra
 * runs arriving.
 *
 * Nothing about the safety rails changes: `auto_generate` is still opt-in, the
 * weekly limit still caps each workspace, and the plan quota still caps the
 * account. Spend follows articles written, not runs.
 *
 * The weekly limit is shared with cron/refresh: a scheduled improvement spends
 * one of the week's articles, and one still due this week is held back from
 * this side so the calendar's promise is the one that gets kept. The
 * arithmetic is lib/plan/pace-budget.ts, read by both crons.
 */

// A literal, and it has to be: route segment config is read statically, so
// `= RUN_BUDGET_SECONDS` fails the build with "Invalid segment configuration
// export detected". Kept in step with that constant, which MAX_ARTICLES_PER_RUN
// is derived from, by a test that reads this line rather than by hoping.
export const maxDuration = 300;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface WorkspaceOutcome {
  workspaceId: string;
  domain: string | null;
  status: "generated" | "skipped" | "error";
  detail: string;
  keyword?: string;
  articleId?: string;
  /** What, if anything, the customer was told about a skip. */
  emailed?: string;
}

async function run(request: Request) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();

  // An account pause whose date has passed ends here, before the queue is
  // read, so those sites are in it. Stripe resumes charging on the date by
  // itself; until this ran, nothing resumed the work it was charging for.
  // Reported, never fatal: a failure to lift one pause is not a reason to
  // write nothing for anybody.
  let resumed: Awaited<ReturnType<typeof resumeExpiredPauses>> | { error: string } = [];
  try {
    resumed = await resumeExpiredPauses(supabase, billingEnabled ? getStripe() : null);
  } catch (err) {
    resumed = { error: err instanceof Error ? err.message : "unknown error" };
  }

  const { data: workspaces, error } = await supabase
    .from("workspaces")
    .select("id, domain, account_id, auto_generate_weekly_limit, refresh_enabled, refresh_days, auto_approve, auto_approve_hold_hours, onboarded_at, onboarding_skipped_at")
    .eq("auto_generate", true)
    .neq("status", "paused");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // A pause lifts by itself, here and at Stripe. Warned a few days out, from
  // the one job that sees every account on every run. Keyed by (account, date),
  // so four runs a day inside the window still send one email.
  const pauseReminders = await remindEndingPauses(supabase);

  const results: WorkspaceOutcome[] = [];
  const since = new Date(Date.now() - WEEK_MS).toISOString();

  // Least-recently-written first, so the cap below rotates rather than serving
  // whoever the database happened to return first on all four daily runs. The
  // window matches the one the weekly limit uses; see lib/content/generate-queue.
  const { data: recent } = await supabase
    .from("articles")
    .select("workspace_id, created_at")
    .eq("generated_autonomously", true)
    .gte("created_at", since)
    .order("created_at", { ascending: false });

  const queue = orderByStaleness(workspaces ?? [], latestPerWorkspace(recent ?? []));

  let written = 0;
  const runStart = Date.now();
  let lastDraftMs: number | null = null;

  for (const ws of queue) {
    if (written >= MAX_ARTICLES_PER_RUN) {
      results.push({
        workspaceId: ws.id as string,
        domain: (ws.domain as string | null) ?? null,
        status: "skipped",
        detail: `run limit reached (${MAX_ARTICLES_PER_RUN}); the next run starts here`,
      });
      continue;
    }
    // The count above is the ceiling; the clock is the bound. A draft started
    // without the time to finish is killed at the function limit and leaves a
    // zero-word row for the sweeper - worse than not starting at all.
    if (written > 0 && !roomForAnother(Date.now() - runStart, lastDraftMs)) {
      results.push({
        workspaceId: ws.id as string,
        domain: (ws.domain as string | null) ?? null,
        status: "skipped",
        detail: `out of time this run (last draft took ${Math.round((lastDraftMs ?? 0) / 1000)}s); the next run starts here`,
      });
      continue;
    }

    const workspaceId = ws.id as string;
    const domain = (ws.domain as string | null) ?? null;
    // A draft whose run died holds its keyword until something says it is
    // not being written (lib/content/stale-drafts.ts). Once a day is enough.
    try {
      await sweepStaleDrafts(supabase, workspaceId);
    } catch {
      // Best effort; the run below does not depend on it.
    }
    // Falls back to the same number the column now defaults to (042), so a
    // row written before that migration is not quietly held at the old 2.
    const limit = (ws.auto_generate_weekly_limit as number) ?? PAID_DEFAULT_PACE;

    try {
      if (limit <= 0) {
        results.push(await skipped(supabase, ws, workspaceId, domain, "weekly limit is 0"));
        continue;
      }

      // Count what was actually done, not what was scheduled: drafts written
      // and rewrites executed, the same week and the same limit. A retry that
      // succeeded after a timeout still consumed budget and still produced a
      // draft somebody has to read.
      const budget = await readPaceBudget(supabase, workspaceId, {
        weeklyLimit: limit,
        refreshEnabled: Boolean(ws.refresh_enabled),
        refreshDays: ws.refresh_days as number[] | null,
      });
      if (budget.articlesLeft <= 0) {
        results.push({
          workspaceId,
          domain,
          status: "skipped",
          detail: `weekly limit reached: ${describePaceBudget(budget)}`,
        });
        continue;
      }

      // Out of quota is a state, not an error. A no-plan account whose free
      // drafts are used would otherwise log an "error" every morning until it
      // paid; the honest word is "skipped", with the reason the queue shows.
      //
      // The gate answers the whole question - free allowance spent, card past
      // due beyond the grace window, subscription cancelled, account paused -
      // in one sentence, so this cron stops for all four rather than only the
      // first. The quota is still read for the paid branch below, which is a
      // volume limit and not an entitlement.
      const spend = await canSpend(supabase, ws.account_id as string, {
        userEmail: null,
        workspaceId,
        action: "scheduled-work",
      });
      if (!spend.allowed) {
        results.push({ workspaceId, domain, status: "skipped", detail: spend.message });
        continue;
      }
      const quota = await getQuota(supabase, ws.account_id as string, null);
      if (quota.limit !== null && (quota.remaining ?? 0) <= 0) {
        results.push({ workspaceId, domain, status: "skipped", detail: quotaExceededMessage(quota) });
        continue;
      }
      // On the free allowance, the second draft waits for the first to be
      // read (lib/billing/first-draft-gate.ts). The allowance is the
      // customer's to spend, not this cron's.
      if (quota.reason === "no-plan") {
        const waiting = await firstDraftAwaitsReview(supabase, workspaceId);
        if (waiting) {
          results.push({ workspaceId, domain, status: "skipped", detail: waiting });
          continue;
        }
      }

      // No vocabulary, no unattended article. With nothing to judge relevance
      // against, the queue is the provider's generic head terms, and the first
      // draft on the lully.ai workspace would have been "ai can". A human can
      // still pick a keyword by hand; the cron does not guess.
      const { data: wsProfile } = await supabase
        .from("workspaces")
        .select("topical_profile")
        .eq("id", workspaceId)
        .single();
      if (!profileIsUsable(wsProfile?.topical_profile as never, domain ?? undefined)) {
        results.push({
          workspaceId,
          domain,
          status: "skipped",
          detail: "the site could not be read well enough to judge which keywords are on-topic; check the audit for why, then pick a keyword by hand",
        });
        continue;
      }

      // Not 25: the list is cut after scoring across every action, so a
      // site with 25 page-one rankings never showed a writable term here
      // (lib/onboarding/plan.ts has the same note).
      const recommendations = await recommendKeywords(supabase, workspaceId, { limit: 1000, qualify: true });
      // The calendar is a promise. If the plan says today is "<term>", write
      // that, and fall back to the live queue only when nothing is due.
      // Retire entries the live queue already covered, or the plan writes the
      // same keyword a second time on its scheduled day. Housekeeping: a
      // failure here must not cost this workspace its draft, so it is reported
      // and stepped over rather than thrown.
      try {
        await closeCoveredEntries(supabase, workspaceId);
      } catch (err) {
        console.warn("[cron/generate] could not close covered calendar entries:", err);
      }
      const due = await duePlannedKeyword(supabase, workspaceId);

      // A due entry the plan cannot pay for is inactive, and the calendar says
      // so (lib/plan/frozen.ts). Skip rather than fall back to the live queue:
      // writing a different keyword instead would spend the allowance the
      // calendar just said was spoken for.
      if (due) {
        const frozen = await readFrozenEntries(supabase, workspaceId, quota);
        if (frozen.ids.has(due.entryId)) {
          results.push({
            workspaceId,
            domain,
            status: "skipped",
            keyword: due.term,
            detail: `"${due.term}" is inactive under the current plan: ${frozen.reason ?? quotaExceededMessage(quota)}`,
          });
          continue;
        }
      }
      // The plan is a promise about a date, not a licence to write anything.
      //
      // `pickNextKeyword` is where the quality bar lives: it writes only what
      // the recommender marked `write`, so out-of-reach terms, provider noise
      // and keywords that argue against what the business sells never reach a
      // draft. A due entry used to skip that check entirely - whatever the
      // calendar named got written, however the recommender had judged it.
      // "business without websites" was queued for qasimcode.com and would
      // have been written despite `commercialFit` refusing it.
      //
      // So a refused plan entry falls back to the live queue, and the slot is
      // still filled: the person was promised an article today, and the honest
      // way to keep that is a keyword worth writing.
      const plannedRec = due ? recommendations.find((r) => r.term === due.term) ?? null : null;
      const planned = plannedRec?.action === "write" ? plannedRec : null;
      const refusedPlan = due && plannedRec && !planned ? plannedRec : null;
      const next = planned ?? pickNextKeyword(recommendations);

      // Said out loud in the run log: a plan quietly overruled is the kind of
      // thing that is only ever noticed months later, from the calendar.
      const overruled = refusedPlan
        ? ` (the plan asked for "${refusedPlan.term}", refused: ${refusedPlan.reasons[0] ?? "not writable"})`
        : "";

      if (!next) {
        results.push(
          await skipped(
            supabase,
            ws,
            workspaceId,
            domain,
            recommendations.length
              ? "no keyword qualifies: all are covered, already ranking, or flagged as provider noise"
              : "no keywords tracked for this workspace",
          ),
        );
        continue;
      }

      const draftStart = Date.now();
      const result = await generateArticle({
        supabase,
        workspaceId,
        keyword: next.term,
        // The planned entry names its keyword row, and that row carries the
        // owner's brief: instructions, answers, shape, length.
        keywordId: planned ? (due?.keywordId ?? next.keywordId) : next.keywordId,
        autonomous: true,
        // Explicitly nobody, matching the getQuota call above. Without this the
        // gate inside generateArticle resolves its own answer and can reach a
        // different verdict for the same account.
        callerEmail: null,
        // Carry the rationale onto the draft. It used to reach the reviewer
        // only as reasons[0] inside an activity-log line, which is the wrong
        // place: the person deciding whether to publish is looking at the
        // article, not the log.
        selection: {
          reasons: next.reasons,
          score: next.score,
          difficulty: next.difficulty,
          volume: next.volume,
        },
      });

      // Counted here, not before the call: a generation that threw consumed
      // time but produced nothing, and the bound is on articles written.
      written += 1;
      lastDraftMs = Date.now() - draftStart;
      // Whichever keyword was written, today's slot is spent. Closing the
      // entry either way stops the plan asking for the same day again, and
      // rewrites it to the keyword actually used when the plan was overruled.
      if (due) {
        await fulfilPlannedEntry(
          supabase,
          due.entryId,
          result.articleId,
          planned ? undefined : { term: next.term, keywordId: next.keywordId },
        );
      }

      // Workspaces that publish automatically: stamp when the hold window
      // ends, so the review card and the email below can say it and the
      // publish cron can act on it (lib/publishing/auto-approve.ts). Never
      // fatal: without the stamp the cron counts the hold from created_at.
      let autoApproveAfter: string | null = null;
      if (ws.auto_approve) {
        const hours = Number(ws.auto_approve_hold_hours ?? 24);
        autoApproveAfter = new Date(Date.now() + hours * 3_600_000).toISOString();
        const { error: stampError } = await supabase
          .from("articles")
          .update({ auto_approve_after: autoApproveAfter })
          .eq("id", result.articleId);
        if (stampError) autoApproveAfter = null;
      }

      // Announce it. A draft nobody is told about is the failure mode this
      // whole schedule creates: four runs a day writing into a queue that only
      // shows itself to someone who opens the dashboard.
      //
      // After the article is saved, and never allowed to fail the run. The
      // work is done and the row exists; an unreachable mail provider must not
      // turn that into an "error" the operator has to investigate, and must not
      // cost the workspace its weekly slot. The outcome is reported instead.
      //
      // A site whose wizard was never finished or skipped gets the setup email
      // instead, carrying this draft: the person left at the CMS step and has
      // not seen the plan screen, so "a draft is ready" without "here is where
      // you stopped" is half the news. Once per site; the drafts after this
      // one are announced the ordinary way.
      let notified = "";
      const setupUnfinished = !ws.onboarded_at && !ws.onboarding_skipped_at;
      try {
        if (setupUnfinished) {
          const line = await announceSetupUnfinished(supabase, {
            accountId: ws.account_id as string,
            workspaceId,
            domain,
          });
          notified = `, setup email: ${line}`;
          results.push({
            workspaceId,
            domain,
            status: "generated",
            keyword: next.term,
            articleId: result.articleId,
            detail: `${result.wordCount} words, fact check ${result.factCheck.verdict}, chosen because ${next.reasons[0]}${overruled}${notified}`,
          });
          continue;
        }
        const to = await accountRecipients(supabase, ws.account_id as string, workspaceId);
        // Whether there is anywhere to publish to, so the mail can say the one
        // honest thing about a site that has connected nothing. Never fatal:
        // undefined leaves the line out rather than guessing.
        let cmsConnected: boolean | undefined;
        try {
          cmsConnected = (await getDestinations(supabase, workspaceId)).length > 0;
        } catch {
          cmsConnected = undefined;
        }
        const out = await sendArticleDraftedEmails(
          supabase,
          to,
          {
            domain,
            keyword: next.term,
            title: result.title,
            wordCount: result.wordCount,
            verdict: result.factCheck.verdict,
            reasons: next.reasons,
            articleId: result.articleId,
            // Already read for the selection above, so the stat row costs
            // nothing extra. Null where the provider measured nothing, which
            // the mail renders as "—" rather than a zero.
            volume: next.volume,
            difficulty: next.difficulty,
            cmsConnected,
            autoApproveAfter,
            holdUrlFor: autoApproveAfter ? (to) => holdUrl(result.articleId, to) : undefined,
          },
          { accountId: ws.account_id as string, workspaceId },
        );
        notified = `, ${describeSendOutcome(out)}`;
      } catch (err) {
        notified = `, email failed (${err instanceof Error ? err.message : "unknown"})`;
      }

      results.push({
        workspaceId,
        domain,
        status: "generated",
        keyword: next.term,
        articleId: result.articleId,
        detail: `${result.wordCount} words, fact check ${result.factCheck.verdict}, chosen because ${next.reasons[0]}${overruled}${notified}`,
      });
    } catch (err) {
      // Two runs overlapped and the other one got there first (migration 074).
      // Nothing went wrong and nothing needs doing: the draft is being
      // written. Reported as a skip so it does not read as an incident, and
      // not counted against `written`, because this run wrote nothing.
      if (err instanceof ConcurrentGenerationError) {
        results.push({
          workspaceId,
          domain,
          status: "skipped",
          keyword: err.keyword,
          detail: err.message,
        });
        continue;
      }
      results.push({
        workspaceId,
        domain,
        status: "error",
        detail: err instanceof Error ? err.message : "unknown error",
      });
    }
  }

  // The sites this run never looked at, because a paused site is filtered out
  // of the query above - which is exactly the state where "nothing is being
  // written" is most obviously true and least visible.
  const pausedNotices = await announcePausedSites(supabase);

  // The sites whose wizard stalled a day ago or more and got no draft above -
  // the analyze cron has read them, and this says what it found and where
  // setup stopped. A site that did get a draft was told at that moment.
  const setupNotices = await sweepUnfinishedSetups(supabase);

  // Drafts sitting in review that nobody has been told about. The signup
  // fan-out announces its own batch from `after()` on the onboarding worker,
  // and `after()` is work a serverless platform may cut short; this is what
  // notices. It writes nothing when every draft has already been announced,
  // which is the normal case, because the loop above announces its own.
  const unannounced = await sweepUnannouncedDrafts(supabase);

  return NextResponse.json({
    checked: workspaces?.length ?? 0,
    pausesResumed: resumed,
    pauseReminders,
    pausedNotices,
    setupNotices,
    unannounced,
    generated: results.filter((r) => r.status === "generated").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    errors: results.filter((r) => r.status === "error").length,
    results,
  });
}

/**
 * Record a skip, and tell the site's team when it is one they can fix.
 *
 * The scheduler's silence is its worst failure mode: it writes "skipped" into
 * a JSON body nobody reads and the calendar simply stops. Not every skip earns
 * an email - `nothingWrittenReason` returns null for the ones the customer
 * cannot act on - and the ones that do are capped at one a week per site.
 */
async function skipped(
  supabase: ReturnType<typeof createServiceClient>,
  ws: { account_id?: unknown },
  workspaceId: string,
  domain: string | null,
  detail: string,
): Promise<WorkspaceOutcome> {
  const reason = nothingWrittenReason(detail);
  const emailed = reason
    ? await announceNothingWritten(
        supabase,
        { accountId: ws.account_id as string, workspaceId, domain },
        reason,
      )
    : undefined;
  return { workspaceId, domain, status: "skipped", detail, ...(emailed ? { emailed } : {}) };
}

/**
 * Every run of this job lands in `system_events` (lib/observability/cron.ts):
 * a throw or a 5xx as an error, per-item failures as a warning, and a clean
 * run as one `info` row — which is the only thing anywhere that proves the
 * schedule is still firing.
 */
export const GET = observedCron("cron.generate", run);
