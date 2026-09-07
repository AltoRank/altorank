import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cron-auth";
import { setSpendReporter } from "@/lib/seo/client";
import { recordSpend } from "@/lib/billing/spend";
import { createServiceClient } from "@/lib/supabase/server";
import { collectRankingTasks, positionFor } from "@/lib/seo/serp";
import { entitledToScheduledWork, getQuota } from "@/lib/billing/quota";
import type { RankingRow } from "@/lib/seo/rankings";
import { observedCron } from "@/lib/observability/cron";

/**
 * Second half of the nightly rank check.
 *
 * cron/serp posts one SERP task per tracked keyword to DataForSEO's standard
 * queue at 03:00. This runs twenty minutes later and collects whatever has
 * finished. The two are separate invocations because the queue answers in
 * about five minutes and a Vercel function should not sit and wait for it.
 *
 * Idempotent: tasks_ready only lists uncollected tasks, and keeps them for
 * three days, so a night this fails to run is made up the next night, and a
 * run that is triggered twice finds nothing the second time.
 */
async function run(request: Request) {
  if (!isAuthorizedCron(request)) {
    setSpendReporter(null);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();
  setSpendReporter(({ operation, costUsd }) => {
    void recordSpend(supabase, { provider: "dataforseo", operation, costUsd });
  });

  let collected;
  let skippedWorkspaces = 0;
  try {
    collected = await collectRankingTasks({
      // cron/serp already refuses to post tasks for an account with no plan,
      // so in the ordinary case this filter drops nothing. It exists for the
      // window in between: a subscription that lapses, is cancelled or is
      // paused after the tasks went out.
      keep: async (workspaceIds) => {
        if (!workspaceIds.length) return new Set<string>();
        const { data: rows } = await supabase
          .from("workspaces")
          .select("id, agency_id")
          .in("id", workspaceIds);
        const entitledAgency = new Map<string, boolean>();
        const keep = new Set<string>();
        for (const row of rows ?? []) {
          const agencyId = row.agency_id as string;
          if (!entitledAgency.has(agencyId)) {
            const quota = await getQuota(supabase, agencyId, null);
            entitledAgency.set(agencyId, entitledToScheduledWork(quota));
          }
          if (entitledAgency.get(agencyId)) keep.add(row.id as string);
        }
        skippedWorkspaces = workspaceIds.length - keep.size;
        return keep;
      },
    });
  } catch (err) {
    setSpendReporter(null);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "collect failed" },
      { status: 500 },
    );
  }

  // Everything below is keyed by workspace, and the tag told us which one.
  const workspaceIds = [...new Set(collected.map((c) => c.workspaceId))];
  const { data: wsRows } = workspaceIds.length
    ? await supabase.from("workspaces").select("id, domain").in("id", workspaceIds)
    : { data: [] as Array<{ id: string; domain: string | null }> };
  const domainOf = new Map((wsRows ?? []).map((w) => [w.id as string, (w.domain as string | null) ?? ""]));

  const checkedAt = new Date().toISOString();
  const rows: RankingRow[] = [];
  const perWorkspace = new Map<string, number>();

  for (const c of collected) {
    const domain = domainOf.get(c.workspaceId);
    // A task for a workspace that no longer exists is not ours to record.
    if (!domain) continue;
    const { position, url } = positionFor(c.items, domain);
    rows.push({ keyword_id: c.keywordId, position, url, checked_at: checkedAt });
    perWorkspace.set(c.workspaceId, (perWorkspace.get(c.workspaceId) ?? 0) + 1);

    // The Articles page's POSITION column: the ranking for an article's own
    // keyword is that number. Same write cron/serp made on the live path.
    await supabase
      .from("articles")
      .update({ position })
      .eq("workspace_id", c.workspaceId)
      .eq("keyword", c.keyword);
  }

  let insertError: string | null = null;
  if (rows.length) {
    const { error } = await supabase.from("keyword_rankings").insert(rows);
    insertError = error?.message ?? null;
  }

  setSpendReporter(null);
  return NextResponse.json({
    success: !insertError,
    collected: collected.length,
    recorded: insertError ? 0 : rows.length,
    // Named, not silent: a night where results were dropped for want of a plan
    // is a fact somebody should be able to read off the response.
    skippedNoPlan: skippedWorkspaces,
    workspaces: Object.fromEntries(perWorkspace),
    ...(insertError ? { error: insertError } : {}),
  });
}

/**
 * Every run of this job lands in `system_events` (lib/observability/cron.ts):
 * a throw or a 5xx as an error, per-item failures as a warning, and a clean
 * run as one `info` row — which is the only thing anywhere that proves the
 * schedule is still firing.
 */
export const GET = observedCron("cron.serp_collect", run);
