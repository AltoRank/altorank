import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cron-auth";
import { setSpendReporter } from "@/lib/seo/client";
import { getQuota, entitledToScheduledWork } from "@/lib/billing/quota";
import { syncBacklinks } from "@/lib/seo/backlinks";
import { recordSpend } from "@/lib/billing/spend";
import { createServiceClient } from "@/lib/supabase/server";
import { postRankingTasks } from "@/lib/seo/serp";
import type { Workspace } from "@/lib/types";
import { selectTrackedKeywords, TRACK_CAP } from "@/lib/seo/tracked-keywords";
import { observedCron } from "@/lib/observability/cron";

/**
 * One DataForSEO round trip per workspace, and the workspace list is not
 * capped, so the time limit is the first thing this runs out of on an account
 * with more than a handful of sites - silently, half way through the list,
 * reporting nothing.
 *
 * This declares the same 300 as analyze, generate, refresh, geo and site-pages.
 * Be clear about what that buys today: the project is on the Vercel **Hobby**
 * plan (verified 2026-09-06 against the deployment serving the crons), which
 * caps a function at 60s and ignores this value. It states the requirement so
 * the job gets its budget the moment the plan changes, and so the gap between
 * what the job needs and what it gets is written down rather than guessed at.
 * The real fix is a resume marker, not a bigger number - see the wiring map.
 */
export const maxDuration = 300;

async function run(request: Request) {
  if (!isAuthorizedCron(request)) {
    setSpendReporter(null);

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  /**
 * Cron requests carry no cookies, so the cookie-bound client authenticates as
 * nobody and RLS answers every query with an empty set. That is not an error,
 * so this route reported `success` with a zero count and had never processed a
 * single row. A cron has no user by definition: it must hold the service role.
 */
  const supabase = createServiceClient();

  // Every workspace except the paused ones. A paused site is paused for the
  // whole product, not only for publishing: posting rank-tracking tasks for it
  // spends DataForSEO money on a client nobody is working for.
  const { data: workspacesData, error: wsError } = await supabase
    .from("workspaces")
    .select("*")
    .neq("status", "paused");

  if (wsError) {
    return NextResponse.json(
      { error: `Failed to fetch workspaces: ${wsError.message}` },
      { status: 500 },
    );
  }

  const workspaces = (workspacesData ?? []) as Workspace[];
  const results: Array<{
    workspaceId: string;
    domain: string;
    /** Tasks queued tonight; cron/serp-collect records the answers. */
    checked: number;
    error?: string;
    /** Set when the workspace was passed over rather than failing. */
    skipped?: string;
  }> = [];

  for (const ws of workspaces) {
    if (!ws.domain) {
      results.push({
        workspaceId: ws.id,
        domain: "",
        checked: 0,
        error: "No domain configured",
      });
      continue;
    }

    // Nothing below is free, and none of it is worth buying for an account
    // that cannot ship what it produces. See entitledToScheduledWork.
    const quota = await getQuota(supabase, ws.account_id as string, null);
    if (!entitledToScheduledWork(quota)) {
      results.push({
        workspaceId: ws.id,
        domain: ws.domain,
        checked: 0,
        skipped: "no plan",
      });
      continue;
    }

    setSpendReporter(({ operation, costUsd }) => {
      void recordSpend(supabase, {
        provider: "dataforseo",
        operation,
        costUsd,
        workspaceId: ws.id,
      });
    });

    // Weekly backlink pass, folded into the daily rank cron: one DataForSEO
    // call per workspace per week (~$0.05). Newest discovered_at older than
    // seven days, or none at all, means it is due.
    try {
      const { data: newest } = await supabase
        .from("backlinks")
        .select("discovered_at")
        .eq("workspace_id", ws.id)
        .order("discovered_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const due = !newest || Date.now() - new Date(newest.discovered_at).getTime() > 7 * 24 * 3600 * 1000;
      if (due) await syncBacklinks(supabase, ws.id, ws.domain);
    } catch (err) {
      console.error(`[cron/serp] backlinks for ${ws.domain}:`, err instanceof Error ? err.message : err);
    }

    try {
      // Planned and shipped terms plus the article keywords, newest first,
      // capped. The same selection the found-live receipt reads before it
      // tells a customer a term is tracked: see lib/seo/tracked-keywords.ts.
      const { keywords, error: kwError } = await selectTrackedKeywords(supabase, ws.id);

      if (kwError) {
        results.push({
          workspaceId: ws.id,
          domain: ws.domain,
          checked: 0,
          error: kwError,
        });
        continue;
      }

      if (keywords.length === TRACK_CAP) {
        console.warn(`[serp] workspace ${ws.domain}: tracking capped at ${TRACK_CAP} keywords`);
      }
      if (keywords.length === 0) {
        results.push({
          workspaceId: ws.id,
          domain: ws.domain,
          checked: 0,
        });
        continue;
      }

      /**
       * Post, don't wait. This used to call the live SERP endpoint for every
       * keyword and process the answers here - $0.002 a keyword for a
       * six-second turnaround that nothing at three in the morning needs.
       * The standard queue is $0.0006 for the same SERP; cron/serp-collect
       * picks the results up twenty minutes later. See lib/seo/serp.ts.
       */
      const { posted, failed } = await postRankingTasks(
        ws.id,
        keywords.map((k) => ({ keywordId: k.id, term: k.term })),
        {
          languageCode: (ws as { language?: string }).language ?? "en",
          locationCode: (ws as { location_code?: number }).location_code ?? 2840,
        },
      );
      if (failed > 0) {
        console.warn(`[serp] workspace ${ws.domain}: ${failed} task(s) refused by DataForSEO`);
      }
      const rankingRows = { length: posted };

      results.push({
        workspaceId: ws.id,
        domain: ws.domain,
        checked: rankingRows.length,
      });
    } catch (err) {
      results.push({
        workspaceId: ws.id,
        domain: ws.domain,
        checked: 0,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  const totalChecked = results.reduce((sum, r) => sum + r.checked, 0);
  const errors = results.filter((r) => r.error).length;
  const skipped = results.filter((r) => r.skipped).length;

  return NextResponse.json({
    success: true,
    workspaces: results.length,
    totalChecked,
    errors,
    skipped,
    results,
  });
}

/**
 * Every run of this job lands in `system_events` (lib/observability/cron.ts):
 * a throw or a 5xx as an error, per-item failures as a warning, and a clean
 * run as one `info` row — which is the only thing anywhere that proves the
 * schedule is still firing.
 */
export const GET = observedCron("cron.serp", run);
