// ---------------------------------------------------------------------------
// A draft nobody is writing
// ---------------------------------------------------------------------------
//
// `articles.status = 'drafting'` means a run is writing it. The run sets
// `error` on failure, but the process can die between the two - a deploy, a
// reboot, a killed dev server, or (measured 2026-09-06) a failure handler
// whose own status update failed. The row then says "drafting" forever:
//
//   - the planner card shows "Writing… stopped responding" with no action,
//     the calendar header counts it as running, and the card's tooltip
//     claims nothing was charged (a $0.22 Claude call had been);
//   - writePlannedEntryNow refuses the keyword with "already being written";
//   - once migration 074's unique index is in, an insert for the same
//     keyword raises unique_violation, so the keyword can never be written.
//
// This is the sweep the product had none of. A draft older than the
// planner's own give-up window with no running job is marked errored, and
// a job still marked running for it is closed. Called before the one-draft-
// per-keyword guard and by the daily generate cron; both are best effort.

import type { SupabaseClient } from "@supabase/supabase-js";

/** Same window the planner card uses before it says "stopped responding". */
export const STALE_DRAFT_MS = 10 * 60_000;

const STALE_ERROR = "Generation stopped without a result; the run that was writing this draft is gone.";

export interface StaleSweep {
  /** Article ids marked errored. */
  swept: string[];
}

export async function sweepStaleDrafts(
  supabase: SupabaseClient,
  workspaceId: string,
  now: number = Date.now(),
): Promise<StaleSweep> {
  const cutoff = new Date(now - STALE_DRAFT_MS).toISOString();
  const { data: drafts } = await supabase
    .from("articles")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("status", "drafting")
    .lt("created_at", cutoff);
  const ids = ((drafts ?? []) as Array<{ id: string }>).map((d) => d.id);
  if (ids.length === 0) return { swept: [] };

  // A job still running - and recently touched - is a writer that is merely
  // slow. Only a draft with no such job is abandoned.
  const { data: jobs } = await supabase
    .from("generation_jobs")
    .select("id, article_id, created_at")
    .in("article_id", ids)
    .eq("status", "running");
  const live = new Set<string>();
  const stuckJobs: string[] = [];
  for (const j of (jobs ?? []) as Array<{ id: string; article_id: string | null; created_at: string }>) {
    if (!j.article_id) continue;
    if (new Date(j.created_at).getTime() >= now - STALE_DRAFT_MS) live.add(j.article_id);
    else stuckJobs.push(j.id);
  }
  const swept = ids.filter((id) => !live.has(id));
  if (swept.length === 0) return { swept: [] };

  const at = new Date(now).toISOString();
  await supabase.from("articles").update({ status: "error", updated_at: at }).in("id", swept);
  if (stuckJobs.length) {
    await supabase.from("generation_jobs").update({ status: "failed", error: STALE_ERROR, completed_at: at }).in("id", stuckJobs);
  }
  return { swept };
}
