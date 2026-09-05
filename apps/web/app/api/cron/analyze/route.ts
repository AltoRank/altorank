import { NextResponse } from "next/server";
import { cronSecretFrom } from "@/lib/cron-auth";
import { setSpendReporter } from "@/lib/seo/client";
import { recordSpend } from "@/lib/billing/spend";
import { createServiceClient } from "@/lib/supabase/server";
import { analyseDomain } from "@/lib/audit/domain-analysis";
import {
  PROFILE_MAX_AGE_DAYS,
  refreshTopicalProfile,
  selectStale,
  type ProfileCandidate,
  type RefreshOutcome,
} from "@/lib/audit/profile-refresh";
import { monthlyTarget, schedulePlan } from "@/lib/onboarding/plan";
import { PAID_DEFAULT_PACE } from "@/lib/content/pace";

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
 * `first_analysed_at` is set even when layers fail, so a domain that cannot be
 * reached is not retried forever. Re-running the full analysis is still a
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

export async function GET(request: Request) {
  const cronSecret = cronSecretFrom(request);
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    setSpendReporter(null);

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();

  const { data: pending, error } = await supabase
    .from("workspaces")
    .select("id, domain, language, location_code")
    .is("first_analysed_at", null)
    .not("domain", "is", null)
    .neq("status", "paused")
    .order("created_at", { ascending: true })
    .limit(BATCH);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const results: Array<Record<string, unknown>> = [];

  for (const ws of pending ?? []) {
    const workspaceId = ws.id as string;
    const domain = ws.domain as string;

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
      });

      results.push({
        workspaceId,
        domain,
        status: "analysed",
        headline: analysis.headline,
        readinessScore: analysis.readiness?.score ?? null,
        pagesCrawled: analysis.pagesCrawled,
        keywordsFound: analysis.keywordsFound,
        layers: analysis.layers,
      });
    } catch (err) {
      // analyseDomain is written not to throw, so reaching here means something
      // outside the layers broke. Stamp the workspace anyway rather than
      // re-crawling a broken domain on every run.
      await supabase
        .from("workspaces")
        .update({ first_analysed_at: new Date().toISOString() })
        .eq("id", workspaceId);

      results.push({
        workspaceId,
        domain,
        status: "error",
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

  return NextResponse.json({
    pending: pending?.length ?? 0,
    analysed: results.filter((r) => r.status === "analysed").length,
    errors: results.filter((r) => r.status === "error").length,
    profileMaxAgeDays: PROFILE_MAX_AGE_DAYS,
    profilesRefreshed: refreshed.filter((r) => r.status === "refreshed").length,
    plansToppedUp: toppedUp.filter((t) => t.added > 0).length,
    results,
    refreshed,
    toppedUp,
  });
}

type TopUp = { workspaceId: string; queued: number; target: number; added: number; error?: string };

async function topUpPlans(supabase: ReturnType<typeof createServiceClient>): Promise<TopUp[]> {
  const out: TopUp[] = [];
  const { data: workspaces } = await supabase
    .from("workspaces")
    .select("id, auto_generate_weekly_limit")
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
      const added = await schedulePlan(supabase, workspaceId, pace, { mode: "top-up" });
      out.push({ workspaceId, queued, target, added: added.length });
    } catch (err) {
      out.push({ workspaceId, queued, target, added: 0, error: err instanceof Error ? err.message : "unknown error" });
    }
  }
  return out;
}
