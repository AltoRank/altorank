import { MAX_PACE, monthlyFromPace } from "@/lib/content/pace";
import type { Opportunity } from "@/lib/keyword-research/opportunity";
import type { KeywordRecommendation } from "@/lib/seo/recommendations";
export const PLAN_HORIZON_DAYS = 30;
/**
 * Hard cap on keywords scheduled per workspace, whatever the pace. The
 * planner header shows "N of 60"; `schedulePlan` and the cron top-up both
 * stop at it. Matches the ceiling users know from other planners.
 */
export const PLAN_MAX_ENTRIES = 60;

export interface PlannedEntry {
  brief?: Opportunity;
  keywordId: string;
  term: string;
  /** ISO date, YYYY-MM-DD, in UTC. */
  date: string;
}

export const DAY_MS = 86_400_000;

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Sunday is 0, as in `publishing_cadences.days_of_week` and `Date#getUTCDay`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** How many entries a month at `weeklyLimit` should hold. */
export function monthlyTarget(weeklyLimit: number): number {
  const weekly = Math.max(0, Math.min(MAX_PACE, Math.floor(weeklyLimit)));
  // The same arithmetic the plan copy quotes ("about N a month"), so the
  // top-up floor never promises more than the pricing page did. Paces above
  // one a day ("two a day", 14) are real since multi-per-day scheduling; the
  // calendar cap is the only ceiling.
  return Math.min(PLAN_MAX_ENTRIES, monthlyFromPace(weekly));
}

/**
 * Spread the queue across the horizon at `weeklyLimit` articles a week.
 *
 * 7 a week is one a day; 1 a week is every seventh day; anything in between
 * spaces entries evenly rather than front-loading the week. Weekends are not
 * skipped by default: a blog that publishes daily publishes on Saturday too.
 *
 * `maxEntries` lets a caller that already holds some of the 60 ask only for
 * the room that is left.
 *
 * `daysOfWeek` is the cadence table's choice of days. When it is given and not
 * empty, every entry lands on one of those weekdays: each seven-day window
 * from `from` gets its `weeklyLimit` entries spread over the allowed days in
 * that window, evenly when there are more days than entries and round-robin
 * (two on a Monday) when there are more entries than days. A pace higher than
 * the number of chosen days is not an error - generation still runs at that
 * pace and the extra drafts wait in review - it just means some days carry
 * two.
 *
 * The calendar plans at most one a day when no days are chosen: above 7 a
 * week the live queue supplies the rest (cron/generate falls back to it when
 * nothing planned is due), so the horizon shows what the schedule promises
 * rather than two chips on every square.
 */
export function buildPlan(
  recommendations: Pick<KeywordRecommendation, "keywordId" | "term" | "action" | "quality" | "opportunity">[],
  opts: {
    weeklyLimit: number;
    from?: Date;
    horizonDays?: number;
    maxEntries?: number;
    daysOfWeek?: readonly number[];
    /**
     * Dates already carrying an entry that survives this plan (written or
     * scheduled). Each one uses up a grid slot on its day, so a re-plan at
     * 3/week does not stack a new entry on the day the first draft occupies.
     */
    occupied?: readonly string[];
  },
): PlannedEntry[] {
  const weekly = Math.max(0, Math.min(MAX_PACE, Math.floor(opts.weeklyLimit)));
  if (weekly === 0) return [];
  const horizon = opts.horizonDays ?? PLAN_HORIZON_DAYS;
  const from = opts.from ?? new Date();
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const cap = Math.max(0, Math.min(PLAN_MAX_ENTRIES, opts.maxEntries ?? PLAN_MAX_ENTRIES));
  const count = Math.min(cap, Math.ceil((weekly * horizon) / 7));

  const usable = recommendations.filter((r) => r.action === "write" && r.quality === "ok" && r.keywordId);
  const offsets = planOffsets(weekly, horizon, count, normaliseDays(opts.daysOfWeek), new Date(start).getUTCDay());
  const taken = new Map<string, number>();
  for (const d of opts.occupied ?? []) taken.set(d, (taken.get(d) ?? 0) + 1);
  const out: PlannedEntry[] = [];
  let k = 0;
  for (const offset of offsets) {
    if (k >= usable.length) break;
    const date = isoDate(new Date(start + offset * DAY_MS));
    const left = taken.get(date) ?? 0;
    if (left > 0) {
      taken.set(date, left - 1);
      continue;
    }
    out.push({ keywordId: usable[k].keywordId, term: usable[k].term, date, ...(usable[k].opportunity ? { brief: usable[k].opportunity } : {}) });
    k++;
  }
  return out;
}

/** Distinct, in range, sorted; undefined when nothing usable was given. */
function normaliseDays(days: readonly number[] | undefined): Weekday[] | undefined {
  if (!days) return undefined;
  const set = new Set<number>();
  for (const d of days) if (Number.isInteger(d) && d >= 0 && d <= 6) set.add(d);
  if (set.size === 0) return undefined;
  return [...set].sort((a, b) => a - b) as Weekday[];
}

/**
 * Day offsets from the start, one per planned entry, ascending.
 *
 * Without chosen days this is the even spacing the plan has always used.
 * With them, each seven-day window is filled from the allowed dates it holds.
 */
function planOffsets(
  weekly: number,
  horizon: number,
  count: number,
  days: Weekday[] | undefined,
  startWeekday: number,
): number[] {
  if (!days) {
    const step = 7 / weekly;
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
      const offset = Math.round(i * step);
      if (offset >= horizon) break;
      out.push(offset);
    }
    return out;
  }

  const out: number[] = [];
  for (let weekStart = 0; weekStart < horizon && out.length < count; weekStart += 7) {
    const allowed: number[] = [];
    for (let d = weekStart; d < weekStart + 7 && d < horizon; d++) {
      if (days.includes(((startWeekday + d) % 7) as Weekday)) allowed.push(d);
    }
    if (allowed.length === 0) continue;
    const n = Math.min(weekly, count - out.length);
    for (let i = 0; i < n; i++) {
      const idx = allowed.length >= n ? Math.floor((i * allowed.length) / n) : i % allowed.length;
      out.push(allowed[idx]);
    }
  }
  return out.sort((a, b) => a - b);
}

/** What a re-plan changes, for saying so before it happens. */
export interface PlanDiff {
  /** Entries that keep both their keyword and their day. */
  unchanged: number;
  /** Planned keywords that stay planned but land on a different day. */
  moved: number;
  /** Keywords newly planned. */
  added: number;
  /** Planned keywords that leave the plan (they stay in the queue, unwritten). */
  removed: number;
}

/**
 * Compare the unfulfilled plan with what a re-plan would write. Pure, so the
 * confirmation copy can be tested; keyed by keyword id, because the term is
 * what the person sees but the id is what the row points at.
 */
export function diffPlan(
  existing: readonly Pick<PlannedEntry, "keywordId" | "date">[],
  next: readonly Pick<PlannedEntry, "keywordId" | "date">[],
): PlanDiff {
  const before = new Map(existing.map((e) => [e.keywordId, e.date]));
  const after = new Map(next.map((e) => [e.keywordId, e.date]));
  let unchanged = 0;
  let moved = 0;
  let added = 0;
  for (const [id, date] of after) {
    if (!before.has(id)) added++;
    else if (before.get(id) === date) unchanged++;
    else moved++;
  }
  let removed = 0;
  for (const id of before.keys()) if (!after.has(id)) removed++;
  return { unchanged, moved, added, removed };
}

/** The plan sentence: "This moves 6 planned articles; nothing already written changes." */
export function describePlanDiff(d: PlanDiff): string {
  const parts: string[] = [];
  if (d.moved) parts.push(`moves ${d.moved} planned ${d.moved === 1 ? "article" : "articles"}`);
  if (d.added) parts.push(`adds ${d.added}`);
  if (d.removed) parts.push(`unplans ${d.removed}`);
  if (parts.length === 0) return "Nothing on the calendar changes; nothing already written changes.";
  return `This ${parts.join(", ")}; nothing already written changes.`;
}


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
