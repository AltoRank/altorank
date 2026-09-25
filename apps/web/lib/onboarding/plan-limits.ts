// ---------------------------------------------------------------------------
// The planner's numbers and date grid, importable from both sides
// ---------------------------------------------------------------------------
//
// Split out of lib/onboarding/plan.ts, which reads the account's quota for the
// trial hold (lib/billing/trial-hold.ts) and so reaches the server client. The
// calendar controls, the research drawer and the planning skeleton render in
// the browser and need only these, so they import this file and never that
// one (lib/observability/__tests__/client-graph.test.ts holds the line).
// plan.ts re-exports all three, so no server caller changed.

import { MAX_PACE } from "@/lib/content/pace";

export const PLAN_HORIZON_DAYS = 30;
/**
 * Hard cap on keywords scheduled per workspace, whatever the pace. The
 * planner header shows "N of 60"; `schedulePlan` and the cron top-up both
 * stop at it. Matches the ceiling users know from other planners.
 */
export const PLAN_MAX_ENTRIES = 60;

const DAY_MS = 86_400_000;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The next `count` open dates at `weeklyLimit` a week, starting at `from`.
 *
 * `occupied` lists the dates already carrying a planned entry; a day is open
 * while it holds fewer entries than the pace allows (one a day at 7/week,
 * one every seventh day at 1/week). Pure, so the fill order can be tested.
 */
export function nextOpenDates(
  occupied: string[],
  weeklyLimit: number,
  count: number,
  from: Date = new Date(),
): string[] {
  const weekly = Math.max(0, Math.min(MAX_PACE, Math.floor(weeklyLimit)));
  if (weekly === 0 || count <= 0) return [];
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const step = 7 / weekly;
  // Above 7/week the grid lands more than one slot on a day, so occupancy is
  // a count per date, not a set: a day is open while it has fewer entries
  // than the grid gives it.
  const taken = new Map<string, number>();
  for (const d of occupied) taken.set(d, (taken.get(d) ?? 0) + 1);
  const out: string[] = [];
  // Walk the pace grid forward until enough open slots are found. Bounded so
  // a fully booked year cannot spin: past a year out, the answer is "no".
  for (let i = 0; out.length < count && i < 366 * weekly; i++) {
    const date = isoDate(new Date(start + Math.floor(i * step) * DAY_MS));
    const left = taken.get(date) ?? 0;
    if (left > 0) {
      taken.set(date, left - 1);
      continue;
    }
    out.push(date);
  }
  return out;
}
