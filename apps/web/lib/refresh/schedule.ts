// ---------------------------------------------------------------------------
// Which site's rewrite runs this morning, and in what order
// ---------------------------------------------------------------------------
//
// cron/refresh runs once a day and has room for two rewrites across every
// site (each is a ~100 s model call inside a 300 s function). Two things went
// wrong with that cap:
//
//   - A third site due on the same weekday was told "the next run starts
//     here", but the next run is tomorrow, which is not its weekday, so it
//     waited a week.
//   - Sites were taken in order of their last analysis, which every site
//     analysed in the same run shares and which a rewrite does not move, so
//     the same sites could win the slots every week.
//
// Now a site whose most recent rewrite day passed without a rewrite gets one
// the next morning instead (a catch-up), still no more than its weekly count
// of rewrites and never two in a day; and the order puts the site the cap
// delayed last time ahead of the ones it did not (see runOrder).
//
// Pure: the route reads the rows and this decides.

/** A refresh task due today or earlier, as the route reads it. */
export interface DueTask {
  id: string;
  workspace_id: string;
  scheduled_for: string;
  created_at: string;
}

/** A rewrite produced in the trailing week (a `refresh_executions` row). */
export interface RecentRun {
  workspace_id: string;
  created_at: string;
}

export type RewriteSlot =
  /** Today is one of the site's days; `task` is the earliest due. */
  | { kind: "scheduled"; task: DueTask }
  /** The site's last rewrite day (`missed`) produced nothing; run its task today. */
  | { kind: "catch_up"; task: DueTask; missed: string }
  | { kind: "none"; reason: string };

const DAY_MS = 86_400_000;
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The most recent of `days` (0 = Sunday, UTC) strictly before today, within the past six days. */
export function lastEnabledDayBefore(days: readonly number[], now: Date): string | null {
  for (let back = 1; back <= 6; back++) {
    const t = now.getTime() - back * DAY_MS;
    if (days.includes(new Date(t).getUTCDay())) return isoDay(t);
  }
  return null;
}

/**
 * What this site may run today.
 *
 * `due` is the site's scheduled tasks due today or earlier, earliest first;
 * `runs` its rewrites in the trailing seven days.
 */
export function rewriteSlot(input: {
  days: readonly number[];
  now: Date;
  due: readonly DueTask[];
  runs: readonly RecentRun[];
}): RewriteSlot {
  const { days, now, due, runs } = input;
  const today = isoDay(now.getTime());
  const startOf = (day: string) => Date.parse(`${day}T00:00:00Z`);
  const ranSince = (day: string) => runs.some((r) => Date.parse(r.created_at) >= startOf(day));

  if (days.includes(now.getUTCDay())) {
    // One a day: a task already run today is this day's improvement.
    if (ranSince(today)) return { kind: "none", reason: "already ran today" };
    const task = due[0];
    return task ? { kind: "scheduled", task } : { kind: "none", reason: "nothing scheduled" };
  }

  const missed = lastEnabledDayBefore(days, now);
  if (!missed) return { kind: "none", reason: "not a scheduled day" };
  // The missed day's slot was used, or the week's count is: nothing to make up.
  if (ranSince(missed) || runs.length >= days.length) return { kind: "none", reason: "not a scheduled day" };
  // Only a task that was waiting when that day began. One scheduled for a
  // later date, or added after the day started, keeps its promise of the
  // next enabled day on or after its date.
  const task = due.find((t) => t.scheduled_for <= missed && Date.parse(t.created_at) < startOf(missed));
  return task ? { kind: "catch_up", task, missed } : { kind: "none", reason: "not a scheduled day" };
}

/**
 * The order the run visits sites. Returns a new array.
 *
 *   1. sites with a rewrite to run today before those without;
 *   2. a catch-up before a scheduled day: it has already waited a day;
 *   3. a site whose last rewrite was itself a catch-up (it ran on a day that
 *      is not one of its days) before one that ran on time - so the site
 *      the cap delayed last week is not the one it delays again;
 *   4. the least recently rewritten (none in the week first);
 *   5. the oldest due task, then the stalest analysis.
 */
export function runOrder<W extends { id: string; refresh_days?: number[] | null; refresh_last_analyzed_at?: string | null }>(
  workspaces: readonly W[],
  slots: ReadonlyMap<string, RewriteSlot>,
  runs: readonly RecentRun[],
): W[] {
  const lastRun = new Map<string, number>();
  for (const r of runs) {
    const t = Date.parse(r.created_at);
    if (!Number.isFinite(t)) continue;
    if (t > (lastRun.get(r.workspace_id) ?? -Infinity)) lastRun.set(r.workspace_id, t);
  }
  const key = (w: W) => {
    const slot = slots.get(w.id);
    const task = slot && slot.kind !== "none" ? slot.task : null;
    const last = lastRun.get(w.id);
    const delayed = last !== undefined && !(w.refresh_days ?? []).includes(new Date(last).getUTCDay());
    return {
      idle: task ? 0 : 1,
      catchUp: slot?.kind === "catch_up" ? 0 : 1,
      delayed: delayed ? 0 : 1,
      last: last ?? -Infinity,
      due: task?.scheduled_for ?? "",
      analysed: w.refresh_last_analyzed_at ?? "",
    };
  };
  const keyed = workspaces.map((w) => ({ w, k: key(w) }));
  keyed.sort(
    (a, b) =>
      a.k.idle - b.k.idle ||
      a.k.catchUp - b.k.catchUp ||
      a.k.delayed - b.k.delayed ||
      (a.k.last === b.k.last ? 0 : a.k.last < b.k.last ? -1 : 1) ||
      a.k.due.localeCompare(b.k.due) ||
      a.k.analysed.localeCompare(b.k.analysed),
  );
  return keyed.map((x) => x.w);
}
