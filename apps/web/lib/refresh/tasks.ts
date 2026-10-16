// ---------------------------------------------------------------------------
// The life of a refresh task outside the rewrite itself
// ---------------------------------------------------------------------------
//
// A task is `scheduled` until cron/refresh picks it up, `running` while the
// rewrite is in flight, then `done` or `failed`. The rewrite runs inside one
// cron invocation (maxDuration 300 s), so a task still `running` long after
// that was cut off by the platform before it could record an outcome. Such a
// row used to stay `running` for good: shown as "Rewriting now…", counted as
// a held slot, and out of reach of cancel, reschedule and dismiss, which all
// matched `scheduled`/`failed` only.
//
// Here a running task older than STALE_RUNNING_MS counts as stopped. The
// cron marks it `failed` at the start of each run, and until it does, the
// person's own actions treat it as open.
//
// `started_at` arrives with migration 117. Before it, the task's `created_at`
// stands in: a task created more than fifteen minutes before it was seen
// running is only stale-looking if a second invocation is running at the same
// moment, and even then the rewrite's own final write puts the row back.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingColumn } from "@/lib/supabase/missing-column";
import type { TaskStatus } from "./types";

/** Well past cron/refresh's 300 s budget: nothing legitimately runs this long. */
export const STALE_RUNNING_MS = 15 * 60_000;

/** What a person reads on a task that was cut off mid-rewrite. */
export const STOPPED_MESSAGE = "The rewrite stopped before it finished. Nothing was changed; reschedule it to try again.";

export interface TaskTiming {
  status: TaskStatus | string;
  started_at?: string | null;
  created_at: string;
}

/** A `running` task that cannot still be running. Pure. */
export function isStaleRunning(t: TaskTiming, now: number = Date.now()): boolean {
  if (t.status !== "running") return false;
  const since = Date.parse(t.started_at ?? t.created_at);
  return Number.isFinite(since) && now - since > STALE_RUNNING_MS;
}

/** A task a person may still move or withdraw: waiting, failed, or stopped mid-run. Pure. */
export function isOpenTask(t: TaskTiming, now: number = Date.now()): boolean {
  return t.status === "scheduled" || t.status === "failed" || isStaleRunning(t, now);
}

export interface TaskRow extends TaskTiming {
  id: string;
  candidate_id: string;
  workspace_id: string;
  status: TaskStatus;
  scheduled_for: string;
}

const COLUMNS = "id, candidate_id, workspace_id, status, scheduled_for, created_at";

/**
 * Tasks matching the filter, with `started_at` when the column exists.
 * Every filter is optional except the statuses; the caller's client decides
 * what RLS lets it see.
 */
export async function readTasks(
  supabase: SupabaseClient,
  filter: { id?: string; candidateIds?: string[]; workspaceId?: string; statuses: TaskStatus[] },
): Promise<TaskRow[]> {
  const run = (columns: string) => {
    let q = supabase.from("refresh_tasks").select(columns).in("status", filter.statuses);
    if (filter.id) q = q.eq("id", filter.id);
    if (filter.candidateIds) q = q.in("candidate_id", filter.candidateIds);
    if (filter.workspaceId) q = q.eq("workspace_id", filter.workspaceId);
    return q;
  };
  let { data, error } = await run(`${COLUMNS}, started_at`);
  if (isMissingColumn(error)) ({ data, error } = await run(COLUMNS));
  if (error) throw new Error(`refresh_tasks: ${error.message}`);
  return (data ?? []) as unknown as TaskRow[];
}

/**
 * Move a task from `scheduled` to `running`, stamping when. Conditional on
 * the status, so two invocations cannot both claim it. False when the task
 * was no longer scheduled.
 */
export async function claimTask(supabase: SupabaseClient, taskId: string, now: Date = new Date()): Promise<boolean> {
  const claim = (patch: Record<string, unknown>) =>
    supabase.from("refresh_tasks").update(patch).eq("id", taskId).eq("status", "scheduled").select("id");
  let { data, error } = await claim({ status: "running", started_at: now.toISOString() });
  if (isMissingColumn(error)) ({ data, error } = await claim({ status: "running" }));
  if (error) throw new Error(`refresh_tasks: ${error.message}`);
  return (data ?? []).length > 0;
}

/**
 * Withdraw the open tasks among `tasks`: each is set to `status` on the
 * condition that it is still in the state it was read in, so a task that
 * moved in between is left alone. Returns how many were withdrawn.
 */
export async function closeOpenTasks(
  supabase: SupabaseClient,
  tasks: TaskRow[],
  patch: { status: "cancelled" } | { status: "failed"; error: string },
  now: number = Date.now(),
): Promise<number> {
  let closed = 0;
  for (const t of tasks) {
    if (!isOpenTask(t, now)) continue;
    const { data, error } = await supabase
      .from("refresh_tasks")
      .update(patch)
      .eq("id", t.id)
      .eq("status", t.status)
      .select("id");
    if (error) throw new Error(`refresh_tasks: ${error.message}`);
    closed += (data ?? []).length;
  }
  return closed;
}

/**
 * Mark every task that was cut off mid-rewrite as failed, with a sentence
 * that says so. Run by cron/refresh before it starts anything, with the
 * service client. Returns how many it marked.
 */
export async function reapStoppedTasks(supabase: SupabaseClient, now: number = Date.now()): Promise<number> {
  const running = await readTasks(supabase, { statuses: ["running"] });
  const stopped = running.filter((t) => isStaleRunning(t, now));
  return closeOpenTasks(supabase, stopped, { status: "failed", error: STOPPED_MESSAGE }, now);
}
