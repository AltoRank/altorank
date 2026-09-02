import { NextResponse } from "next/server";
import { cronSecretFrom } from "@/lib/cron-auth";
import { setSpendReporter } from "@/lib/seo/client";
import { recordSpend } from "@/lib/billing/spend";
import { createServiceClient } from "@/lib/supabase/server";
import { collectRankingTasks, positionFor } from "@/lib/seo/serp";
import type { RankingRow } from "@/lib/seo/rankings";

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
export async function GET(request: Request) {
  const cronSecret = cronSecretFrom(request);
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    setSpendReporter(null);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();
  setSpendReporter(({ operation, costUsd }) => {
    void recordSpend(supabase, { provider: "dataforseo", operation, costUsd });
  });

  let collected;
  try {
    collected = await collectRankingTasks();
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
    workspaces: Object.fromEntries(perWorkspace),
    ...(insertError ? { error: insertError } : {}),
  });
}
