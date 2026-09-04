// ---------------------------------------------------------------------------
// The first thirty days, scheduled
// ---------------------------------------------------------------------------
//
// Onboarding used to end with a keyword list and one draft. A list is not a
// plan: nothing said what would be written on which day, so the calendar was
// empty until the cron happened to fire. This turns the top of the recommended
// queue into dated calendar entries at the workspace's own pace, so the person
// who just finished the wizard sees what the next month will produce and can
// drag, delete or reprioritise before anything is written.
//
// Pure scheduling is separate from the write so it can be tested without a
// database. Nothing here generates anything; the cron still picks the day's
// entry and still lands it in review.

import type { SupabaseClient } from "@supabase/supabase-js";
import { recommendKeywords, type KeywordRecommendation } from "@/lib/seo/recommendations";

export const PLAN_HORIZON_DAYS = 30;
/** Outrank's hard cap is 60 scheduled keywords; ours matches the horizon. */
export const PLAN_MAX_ENTRIES = 30;

export interface PlannedEntry {
  keywordId: string;
  term: string;
  /** ISO date, YYYY-MM-DD, in UTC. */
  date: string;
}

const DAY_MS = 86_400_000;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Sunday is 0, as in `publishing_cadences.days_of_week` and `Date#getUTCDay`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Spread the queue across the horizon at `weeklyLimit` articles a week.
 *
 * 7 a week is one a day; 1 a week is every seventh day; anything in between
 * spaces entries evenly rather than front-loading the week. Weekends are not
 * skipped by default: a blog that publishes daily publishes on Saturday too.
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
  recommendations: Pick<KeywordRecommendation, "keywordId" | "term" | "action" | "quality">[],
  opts: { weeklyLimit: number; from?: Date; horizonDays?: number; daysOfWeek?: readonly number[] },
): PlannedEntry[] {
  const weekly = Math.max(0, Math.min(7, Math.floor(opts.weeklyLimit)));
  if (weekly === 0) return [];
  const horizon = opts.horizonDays ?? PLAN_HORIZON_DAYS;
  const from = opts.from ?? new Date();
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const count = Math.min(PLAN_MAX_ENTRIES, Math.ceil((weekly * horizon) / 7));

  const usable = recommendations.filter((r) => r.action === "write" && r.quality === "ok" && r.keywordId);
  const offsets = planOffsets(weekly, horizon, count, normaliseDays(opts.daysOfWeek), new Date(start).getUTCDay());
  const out: PlannedEntry[] = [];
  for (let i = 0; i < Math.min(offsets.length, usable.length); i++) {
    out.push({ keywordId: usable[i].keywordId, term: usable[i].term, date: isoDate(new Date(start + offsets[i] * DAY_MS)) });
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

export interface PlanOptions {
  from?: Date;
  /** Weekdays the site publishes on, from its cadence. Absent = any day. */
  daysOfWeek?: readonly number[];
}

/** The unfulfilled plan: queued entries with no article yet. */
export async function readPlannedEntries(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<PlannedEntry[]> {
  const { data } = await supabase
    .from("calendar_entries")
    .select("keyword_id, keyword, scheduled_date")
    .eq("workspace_id", workspaceId)
    .eq("status", "queue")
    .is("article_id", null)
    .order("scheduled_date", { ascending: true });
  return (data ?? [])
    .filter((r) => r.keyword_id)
    .map((r) => ({ keywordId: r.keyword_id as string, term: r.keyword as string, date: r.scheduled_date as string }));
}

/**
 * What `schedulePlan` would write at this pace and these days, and how that
 * differs from the plan as it stands. Reads only.
 */
export async function previewPlan(
  supabase: SupabaseClient,
  workspaceId: string,
  weeklyLimit: number,
  opts: PlanOptions = {},
): Promise<{ next: PlannedEntry[]; diff: PlanDiff }> {
  const [recs, existing] = await Promise.all([
    recommendKeywords(supabase, workspaceId, { limit: 60 }),
    readPlannedEntries(supabase, workspaceId),
  ]);
  const next = buildPlan(recs, { weeklyLimit, from: opts.from, daysOfWeek: opts.daysOfWeek });
  return { next, diff: diffPlan(existing, next) };
}

/**
 * Write the plan for a workspace. Idempotent: queued entries that never became
 * an article are replaced, entries that did are left alone. Lowering the pace
 * therefore keeps the top of the queue and drops the tail; raising it tops up.
 */
export async function schedulePlan(
  supabase: SupabaseClient,
  workspaceId: string,
  weeklyLimit: number,
  opts: PlanOptions = {},
): Promise<PlannedEntry[]> {
  const recs = await recommendKeywords(supabase, workspaceId, { limit: 60 });
  const plan = buildPlan(recs, { weeklyLimit, from: opts.from, daysOfWeek: opts.daysOfWeek });
  await supabase
    .from("calendar_entries")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("status", "queue")
    .is("article_id", null);
  if (plan.length === 0) return plan;
  const { error } = await supabase.from("calendar_entries").insert(
    plan.map((p) => ({
      workspace_id: workspaceId,
      keyword_id: p.keywordId,
      keyword: p.term,
      scheduled_date: p.date,
      status: "queue",
    })),
  );
  if (error) throw new Error(error.message);
  return plan;
}

/**
 * The planned keyword the cron should write today, if any: the earliest
 * queued entry on or before `today` that has no article yet.
 */
export async function duePlannedKeyword(
  supabase: SupabaseClient,
  workspaceId: string,
  today: Date = new Date(),
): Promise<{ entryId: string; keywordId: string | null; term: string } | null> {
  const { data } = await supabase
    .from("calendar_entries")
    .select("id, keyword_id, keyword")
    .eq("workspace_id", workspaceId)
    .eq("status", "queue")
    .is("article_id", null)
    .lte("scheduled_date", isoDate(today))
    .order("scheduled_date", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!data?.keyword) return null;
  return { entryId: data.id as string, keywordId: (data.keyword_id as string | null) ?? null, term: data.keyword as string };
}

/** Mark a planned entry as written. */
export async function fulfilPlannedEntry(supabase: SupabaseClient, entryId: string, articleId: string): Promise<void> {
  await supabase.from("calendar_entries").update({ article_id: articleId, status: "scheduled" }).eq("id", entryId);
}
