import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cron-auth";
import { setSpendReporter } from "@/lib/seo/client";
import { recordSpend } from "@/lib/billing/spend";
import { createServiceClient } from "@/lib/supabase/server";
import { canSpend } from "@/lib/billing/spend-gate";
import { analyseDomain } from "@/lib/audit/domain-analysis";
import {
  MAX_ANALYSIS_ATTEMPTS,
  decideFirstLook,
  firstLookPatch,
  retryEligibleBefore,
} from "@/lib/audit/first-look";
import {
  PROFILE_MAX_AGE_DAYS,
  refreshTopicalProfile,
  selectStale,
  type ProfileCandidate,
  type RefreshOutcome,
} from "@/lib/audit/profile-refresh";
import { monthlyTarget, schedulePlan } from "@/lib/onboarding/plan";
import { recommendKeywords, pickNextKeyword } from "@/lib/seo/recommendations";
import { topUpKeywords, type TopUpOutcome } from "@/lib/keyword-research/top-up";
import { PAID_DEFAULT_PACE } from "@/lib/content/pace";
import { observedCron } from "@/lib/observability/cron";

/**
 * First-look analysis for domains nobody has looked at yet.
 *
 *   GET /api/cron/analyze    header: x-cron-secret
 *
 * Adding a client produced an empty workspace: zero keywords, no audit, no
 * readiness score, and a dashboard full of dashes until somebody went and
 * clicked two different buttons. Every one of those analyses reads only public
 * information, so there was never a reason to wait for the client to connect
 * anything first.
 *
 * A cron rather than a fire-and-forget call at workspace creation. Serverless
 * kills a request's background work as soon as the response is sent, so
 * anything started there dies partway through a crawl. Picking the work up from
 * the database makes it restartable and survives a deploy mid-analysis.
 *
 * `first_analysed_at` is set when a run reads the site, and when a run that
 * read nothing has used up its attempts - so a domain that cannot be reached
 * is still not retried forever, but a domain that was merely unreachable for a
 * minute gets looked at again. See lib/audit/first-look.ts for why: two real
 * signups were stamped `analysed` off crawls that fetched zero pages and could
 * never be picked up again. Re-running a *completed* analysis is still a
 * manual action.
 *
 * The topical profile is the exception, and it had to become one. Nothing ever
 * rebuilt it, so the vocabulary a site was given the day it was added was the
 * vocabulary it kept - and since that profile is what scoreRelevance judges
 * every keyword against, a stale one quietly mis-ranks the whole unattended
 * queue. It also meant a change to how profiles are built could not reach an
 * existing site: PR #33 was inert in production until every site was re-crawled
 * by hand. A refresh is only a crawl, with none of the paid layers, so it runs
 * here on the slots first-look analysis did not need.
 */

export const maxDuration = 300;

/** Bounded per invocation: each analysis crawls a site and calls two APIs. */
const BATCH = 3;

async function run(request: Request) {
  if (!isAuthorizedCron(request)) {
    setSpendReporter(null);

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();
  const startedAt = new Date();

  // A workspace nobody has read yet, that has attempts left, and that was not
  // just tried. Ordered by attempts first so a retry can never take the slot
  // of a signup that has had no look at all.
  const { data: pending, error } = await supabase
    .from("workspaces")
    .select("id, domain, account_id, language, location_code, analysis_attempts")
    .is("first_analysed_at", null)
    .lt("analysis_attempts", MAX_ANALYSIS_ATTEMPTS)
    .or(
      `last_analysis_attempt_at.is.null,last_analysis_attempt_at.lt.${retryEligibleBefore(startedAt)}`,
    )
    .not("domain", "is", null)
    .neq("status", "paused")
    .order("analysis_attempts", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(BATCH);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const results: Array<Record<string, unknown>> = [];

  for (const ws of pending ?? []) {
    const workspaceId = ws.id as string;
    const domain = ws.domain as string;

    // The first look is the most expensive thing a workspace ever buys
    // (~$0.20 of DataForSEO plus a PageSpeed run), and this cron was the one
    // spending path with no billing check at all. `canSpend` rather than
    // `entitledToScheduledWork`: a brand-new free account is inside its
    // allowance and must still get its first look - the whole free tier
    // depends on it. What this stops is an account whose allowance is gone,
    // or whose card lapsed, adding a fresh domain for another free analysis.
    const spend = await canSpend(supabase, ws.account_id as string, {
      userEmail: null,
      workspaceId,
      action: "site-audit",
    });
    if (!spend.allowed) {
      results.push({ workspaceId, domain, status: "skipped", detail: spend.message });
      continue;
    }

    setSpendReporter(({ operation, costUsd }) => {
      void recordSpend(supabase, {
        provider: "dataforseo",
        operation,
        costUsd,
        workspaceId,
      });
    });

    try {
      const analysis = await analyseDomain({
        domain,
        supabase,
        workspaceId,
        locale: (ws.language as string) ?? "en",
        locationCode: (ws.location_code as number | null) ?? undefined,
        // So a run that reads nothing can count itself against the bound.
        analysisAttempts: (ws.analysis_attempts as number | null) ?? 0,
      });

      results.push({
        workspaceId,
        domain,
        // "analysed" only when the site was actually read. A run that fetched
        // no page is an attempt, and saying so here is the difference between
        // a quiet zero in the cron log and a workspace somebody can chase.
        status: analysis.firstLook?.reason === "retry" ? "unreadable" : "analysed",
        attempt: analysis.firstLook?.attempts ?? null,
        headline: analysis.headline,
        readinessScore: analysis.readiness?.score ?? null,
        pagesCrawled: analysis.pagesCrawled,
        keywordsFound: analysis.keywordsFound,
        layers: analysis.layers,
      });
    } catch (err) {
      // analyseDomain is written not to throw, so reaching here means something
      // outside the layers broke - and nothing was read. Count it as an
      // attempt on the same terms as an empty crawl: retried a few times, then
      // stamped so a permanently broken domain is left alone.
      const decision = decideFirstLook({
        attemptsBefore: (ws.analysis_attempts as number | null) ?? 0,
        pagesCrawled: 0,
        failedForGood: false,
      });
      await supabase
        .from("workspaces")
        .update(firstLookPatch(decision, new Date().toISOString()))
        .eq("id", workspaceId);

      results.push({
        workspaceId,
        domain,
        status: "error",
        attempt: decision.attempts,
        willRetry: !decision.settled,
        detail: err instanceof Error ? err.message : "unknown error",
      });
    }
  }

  // Refreshes take what first-look analysis left. A new domain has nothing at
  // all and waits for no one; a month-old profile can wait another day. When
  // three domains are pending this run does no refreshing, which is correct -
  // both share one 300s invocation.
  const refreshed: RefreshOutcome[] = [];
  const slots = BATCH - (pending?.length ?? 0);

  if (slots > 0) {
    // Oldest first, nulls before them, so the queue rotates instead of
    // re-crawling the same sites. `.lt()` on the JSON key would drop rows with
    // no builtAt at all - the ones that need this most - so staleness is
    // decided in selectStale rather than in the filter.
    const { data: candidates } = await supabase
      .from("workspaces")
      .select("id, domain, built:topical_profile->>builtAt")
      .not("domain", "is", null)
      .not("first_analysed_at", "is", null)
      .neq("status", "paused")
      .order("topical_profile->>builtAt", { ascending: true, nullsFirst: true })
      .limit(slots);

    for (const ws of selectStale((candidates ?? []) as ProfileCandidate[], slots)) {
      refreshed.push(await refreshTopicalProfile(supabase, ws.id, ws.domain as string));
    }
  }

  // Keep the calendar full. The plan onboarding wrote covers thirty days; on
  // day thirty-one the generate cron would fall back to the live queue and the
  // calendar would go blank, which reads as "nothing is coming". So each run
  // tops up any opted-in workspace whose unwritten plan has dropped below what
  // its pace promises for a month. Additive - it never moves or removes an
  // entry a person placed - and bounded by the same 60 cap as the planner.
  const toppedUp = await topUpPlans(supabase);

  // Keep the pool full, not just the calendar. Discovery runs once per
  // workspace ever, so a site that has written its way through its twenty
  // keywords answers "no keyword qualifies" forever and quietly stops.
  const pools = await refillEmptyPools(supabase);

  return NextResponse.json({
    pending: pending?.length ?? 0,
    analysed: results.filter((r) => r.status === "analysed").length,
    unreadable: results.filter((r) => r.status === "unreadable").length,
    errors: results.filter((r) => r.status === "error").length,
    profileMaxAgeDays: PROFILE_MAX_AGE_DAYS,
    profilesRefreshed: refreshed.filter((r) => r.status === "refreshed").length,
    plansToppedUp: toppedUp.filter((t) => t.added > 0).length,
    poolsRefilled: pools.filter((p) => p.inserted > 0).length,
    results,
    refreshed,
    toppedUp,
    pools,
  });
}

/** How many pools one run will refill: each is a crawl-free provider call. */
const POOL_REFILL_BATCH = 3;

type PoolRefill = TopUpOutcome & { workspaceId: string; domain: string | null };

/**
 * Refill the pool of any workspace that has run out of keywords worth writing.
 *
 * Exhaustion is asked the same way the generate cron asks it - run the
 * recommender, then `pickNextKeyword` - so this fires exactly when generation
 * would otherwise report "no keyword qualifies", and never on a workspace that
 * still has something to write.
 *
 * Gated on spend, like every other paid path. An account that has used its free
 * allowance does not get its pool refilled: buying more keywords for a site
 * that cannot write them is spending on a customer who has not converted.
 */
async function refillEmptyPools(
  supabase: ReturnType<typeof createServiceClient>,
): Promise<PoolRefill[]> {
  const out: PoolRefill[] = [];
  const { data: workspaces } = await supabase
    .from("workspaces")
    .select("id, domain, account_id, language, location_code")
    .eq("auto_generate", true)
    .not("first_analysed_at", "is", null)
    .neq("status", "paused");

  for (const ws of workspaces ?? []) {
    if (out.length >= POOL_REFILL_BATCH) break;
    const workspaceId = ws.id as string;

    let exhausted = false;
    try {
      const recs = await recommendKeywords(supabase, workspaceId, { limit: 1000, qualify: true });
      exhausted = pickNextKeyword(recs) === null;
    } catch {
      // A recommender that cannot run is not evidence of an empty pool.
      continue;
    }
    if (!exhausted) continue;

    const spend = await canSpend(supabase, ws.account_id as string, {
      userEmail: null,
      workspaceId,
      action: "keyword-research",
    });
    if (!spend.allowed) {
      out.push({
        workspaceId,
        domain: (ws.domain as string | null) ?? null,
        candidates: 0,
        priced: 0,
        inserted: 0,
        bySource: { ideas: 0, playbook: 0 },
        reason: spend.message ?? "not entitled to keyword research",
      });
      continue;
    }

    setSpendReporter(({ operation, costUsd }) => {
      void recordSpend(supabase, { provider: "dataforseo", operation, costUsd, workspaceId });
    });
    const outcome = await topUpKeywords(supabase, workspaceId, {
      locale: (ws.language as string) ?? "en",
      locationCode: (ws.location_code as number | null) ?? undefined,
    });
    setSpendReporter(null);
    out.push({ ...outcome, workspaceId, domain: (ws.domain as string | null) ?? null });
  }
  return out;
}

type TopUp = { workspaceId: string; queued: number; target: number; added: number; error?: string };

async function topUpPlans(supabase: ReturnType<typeof createServiceClient>): Promise<TopUp[]> {
  const out: TopUp[] = [];
  const { data: workspaces } = await supabase
    .from("workspaces")
    .select("id, auto_generate_weekly_limit, publishing_cadences(days_of_week, enabled)")
    .eq("auto_generate", true)
    .neq("status", "paused");

  for (const ws of workspaces ?? []) {
    const workspaceId = ws.id as string;
    const pace = (ws.auto_generate_weekly_limit as number | null) ?? PAID_DEFAULT_PACE;
    const target = monthlyTarget(pace);
    const { count } = await supabase
      .from("calendar_entries")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("status", "queue")
      .is("article_id", null);
    const queued = count ?? 0;
    if (target === 0 || queued >= target) {
      out.push({ workspaceId, queued, target, added: 0 });
      continue;
    }
    try {
      // The site's publishing days, as the Articles-plan control passes them;
      // without this the top-up spread entries over days the cadence excludes.
      const cadence = (ws as { publishing_cadences?: { days_of_week: number[]; enabled: boolean } | { days_of_week: number[]; enabled: boolean }[] | null }).publishing_cadences;
      const row = Array.isArray(cadence) ? cadence[0] : cadence;
      const daysOfWeek = row?.enabled && row.days_of_week?.length ? row.days_of_week : undefined;
      const added = await schedulePlan(supabase, workspaceId, pace, { mode: "top-up", daysOfWeek });
      out.push({ workspaceId, queued, target, added: added.length });
    } catch (err) {
      out.push({ workspaceId, queued, target, added: 0, error: err instanceof Error ? err.message : "unknown error" });
    }
  }
  return out;
}

/**
 * Every run of this job lands in `system_events` (lib/observability/cron.ts):
 * a throw or a 5xx as an error, per-item failures as a warning, and a clean
 * run as one `info` row — which is the only thing anywhere that proves the
 * schedule is still firing.
 */
export const GET = observedCron("cron.analyze", run);
