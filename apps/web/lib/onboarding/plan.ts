// ---------------------------------------------------------------------------
// The first thirty days, scheduled
// ---------------------------------------------------------------------------
//
// Onboarding used to end with a keyword list and one draft. A list is not a
// plan: nothing said what would be written on which day, so the calendar was
// empty until the cron happened to fire. This turns the top of the recommended
// queue into dated calendar entries at the workspace's own pace, so the person
// who just finished the wizard sees what the next month will produce and can
// move, delete or reprioritise before anything is written.
//
// Pure scheduling is separate from the write so it can be tested without a
// database. Nothing here generates anything; the cron still picks the day's
// entry and still lands it in review.

import type { SupabaseClient } from "@supabase/supabase-js";
import { recommendKeywords, type KeywordRecommendation } from "@/lib/seo/recommendations";
import { classifyKeyword } from "@/lib/keywords/taxonomy";
import { generateQualityQuestionsBatch, parseStoredQuestions, toQualityQuestions } from "@/lib/keywords/questions";
import type { BusinessProfile } from "@/lib/onboarding/business-profile";
import type { KeywordIntent } from "@/lib/types";

export const PLAN_HORIZON_DAYS = 30;
/**
 * Hard cap on keywords scheduled per workspace, whatever the pace. The
 * planner header shows "N of 60"; `schedulePlan` and the cron top-up both
 * stop at it. Matches the ceiling users know from other planners.
 */
export const PLAN_MAX_ENTRIES = 60;

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

/** How many entries a month at `weeklyLimit` should hold. */
export function monthlyTarget(weeklyLimit: number): number {
  const weekly = Math.max(0, Math.min(7, Math.floor(weeklyLimit)));
  return Math.min(PLAN_MAX_ENTRIES, Math.ceil((weekly * PLAN_HORIZON_DAYS) / 7));
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
  recommendations: Pick<KeywordRecommendation, "keywordId" | "term" | "action" | "quality">[],
  opts: { weeklyLimit: number; from?: Date; horizonDays?: number; maxEntries?: number; daysOfWeek?: readonly number[] },
): PlannedEntry[] {
  const weekly = Math.max(0, Math.min(7, Math.floor(opts.weeklyLimit)));
  if (weekly === 0) return [];
  const horizon = opts.horizonDays ?? PLAN_HORIZON_DAYS;
  const from = opts.from ?? new Date();
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const cap = Math.max(0, Math.min(PLAN_MAX_ENTRIES, opts.maxEntries ?? PLAN_MAX_ENTRIES));
  const count = Math.min(cap, Math.ceil((weekly * horizon) / 7));

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
  /**
   * `replace` (the default, what onboarding and the Articles-plan control do)
   * drops queued entries that never became an article and lays the month out
   * again. `top-up` keeps every existing entry - including ones a person moved
   * - and only appends, from the day after the last one, until the month holds
   * what the pace promises. The cron uses `top-up`; a plan someone has edited
   * must not be rewritten under them.
   */
  mode?: "replace" | "top-up";
}

type ExistingEntry = {
  keyword_id: string | null;
  keyword: string | null;
  scheduled_date: string;
  article_id: string | null;
  status: string;
};

/** Everything on the calendar that still counts against the cap. */
async function scheduledEntries(supabase: SupabaseClient, workspaceId: string): Promise<ExistingEntry[]> {
  const { data } = await supabase
    .from("calendar_entries")
    .select("keyword_id, keyword, scheduled_date, article_id, status")
    .eq("workspace_id", workspaceId)
    .in("status", ["queue", "scheduled"]);
  return (data ?? []) as ExistingEntry[];
}

/** Scheduled keywords for the planner header: "N of 60". */
export async function countScheduled(supabase: SupabaseClient, workspaceId: string): Promise<number> {
  return (await scheduledEntries(supabase, workspaceId)).length;
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
 * The site's publishing days from its cadence row, for planning onto them.
 * Undefined when the cadence is off or unset: the plan then uses any day.
 */
export async function cadenceDays(supabase: SupabaseClient, workspaceId: string): Promise<number[] | undefined> {
  const { data } = await supabase
    .from("publishing_cadences")
    .select("days_of_week, enabled")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!data?.enabled) return undefined;
  const days = (data.days_of_week as number[] | null) ?? [];
  return days.length ? days : undefined;
}

/** The rows a `replace` run deletes before it plans: queued, never written. */
function isReplaceable(e: ExistingEntry): boolean {
  return e.status === "queue" && !e.article_id;
}

/**
 * What the plan would hold given what is already on the calendar. Shared by
 * `schedulePlan` (which writes it) and `previewPlan` (which only describes
 * it), so the confirmation sentence and the write cannot disagree.
 *
 * Keywords a person removed from the planner are skipped, as are ids and
 * terms already on the calendar. Returns the recommendations it drew from as
 * well, so the caller can decorate the planned rows with their intent.
 */
async function computePlan(
  supabase: SupabaseClient,
  workspaceId: string,
  weeklyLimit: number,
  opts: PlanOptions,
  existing: ExistingEntry[],
): Promise<{ plan: PlannedEntry[]; recs: KeywordRecommendation[] }> {
  const mode = opts.mode ?? "replace";
  const room = PLAN_MAX_ENTRIES - existing.length;
  if (room <= 0) return { plan: [], recs: [] };

  const { data: excludedRows } = await supabase
    .from("keywords")
    .select("id")
    .eq("workspace_id", workspaceId)
    .not("plan_excluded_at", "is", null);
  const excluded = new Set((excludedRows ?? []).map((r) => r.id as string));
  const takenIds = new Set(existing.map((e) => e.keyword_id).filter(Boolean) as string[]);
  const takenTerms = new Set(existing.map((e) => (e.keyword ?? "").toLowerCase()).filter(Boolean));

  const recs = (await recommendKeywords(supabase, workspaceId, { limit: 80 })).filter(
    (r) => !excluded.has(r.keywordId) && !takenIds.has(r.keywordId) && !takenTerms.has(r.term.toLowerCase()),
  );

  let start = opts.from ?? new Date();
  let maxEntries = room;
  if (mode === "top-up") {
    const unwritten = existing.filter((e) => !e.article_id).length;
    maxEntries = Math.min(room, Math.max(0, monthlyTarget(weeklyLimit) - unwritten));
    if (maxEntries === 0) return { plan: [], recs };
    const last = existing.map((e) => e.scheduled_date).sort().at(-1);
    if (last) {
      const next = new Date(new Date(`${last}T00:00:00Z`).getTime() + DAY_MS);
      if (next > start) start = next;
    }
  }

  const plan = buildPlan(recs, { weeklyLimit, from: start, maxEntries, daysOfWeek: opts.daysOfWeek });
  return { plan, recs };
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
  const all = await scheduledEntries(supabase, workspaceId);
  const mode = opts.mode ?? "replace";
  // A replace run deletes the unfulfilled queue first; simulate that so the
  // preview plans into the same room the write will have.
  const remaining = mode === "replace" ? all.filter((e) => !isReplaceable(e)) : all;
  const [{ plan: next }, existing] = await Promise.all([
    computePlan(supabase, workspaceId, weeklyLimit, opts, remaining),
    readPlannedEntries(supabase, workspaceId),
  ]);
  return { next, diff: diffPlan(existing, next) };
}

/**
 * Write the plan for a workspace. See `PlanOptions.mode` for `replace` versus
 * `top-up`; `daysOfWeek` lands every entry on the site's publishing days.
 * Lowering the pace keeps the top of the queue and drops the tail; raising it
 * tops up.
 */
export async function schedulePlan(
  supabase: SupabaseClient,
  workspaceId: string,
  weeklyLimit: number,
  opts: PlanOptions = {},
): Promise<PlannedEntry[]> {
  const mode = opts.mode ?? "replace";
  if (mode === "replace") {
    await supabase
      .from("calendar_entries")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("status", "queue")
      .is("article_id", null);
  }

  const existing = await scheduledEntries(supabase, workspaceId);
  const { plan, recs } = await computePlan(supabase, workspaceId, weeklyLimit, opts, existing);
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

  // Best-effort: a plan is written even if the shape or the questions fail.
  try {
    const intents = new Map(recs.map((r) => [r.keywordId, r.intent]));
    await decoratePlannedKeywords(supabase, workspaceId, plan.map((p) => p.keywordId), intents);
  } catch (err) {
    console.warn("[plan] could not decorate planned keywords:", err instanceof Error ? err.message : err);
  }
  return plan;
}

/**
 * Give planned keywords their article shape and their questions.
 *
 * Shape is rule-based and free, so every planned keyword gets one. Questions
 * are one model call for the whole batch; a keyword the model did not answer
 * for keeps an empty array, and the card offers to generate when opened.
 */
export async function decoratePlannedKeywords(
  supabase: SupabaseClient,
  workspaceId: string,
  keywordIds: string[],
  intents: Map<string, KeywordIntent> = new Map(),
): Promise<{ classified: number; questioned: number }> {
  if (keywordIds.length === 0) return { classified: 0, questioned: 0 };
  const { data } = await supabase
    .from("keywords")
    .select("id, term, intent, article_subtype, quality_questions")
    .eq("workspace_id", workspaceId)
    .in("id", keywordIds);
  const rows = (data ?? []) as Array<{ id: string; term: string; intent: KeywordIntent | null; article_subtype: string | null; quality_questions: unknown }>;

  let classified = 0;
  for (const row of rows) {
    if (row.article_subtype) continue;
    const shape = classifyKeyword(row.term, intents.get(row.id) ?? row.intent);
    await supabase.from("keywords").update(shape).eq("id", row.id).eq("workspace_id", workspaceId);
    classified++;
  }

  const questioned = await ensureQuestionsFor(
    supabase,
    workspaceId,
    rows.filter((r) => parseStoredQuestions(r.quality_questions).length === 0).map((r) => ({ id: r.id, term: r.term })),
  );
  return { classified, questioned };
}

/**
 * Generate and store questions for keywords that have none. Returns how many
 * received some. Never throws for a model failure: the array stays empty and
 * that is the honest state.
 */
export async function ensureQuestionsFor(
  supabase: SupabaseClient,
  workspaceId: string,
  keywords: Array<{ id: string; term: string }>,
): Promise<number> {
  if (keywords.length === 0) return 0;
  const { data: ws } = await supabase
    .from("workspaces")
    .select("business_profile")
    .eq("id", workspaceId)
    .maybeSingle();
  const profile = (ws?.business_profile as BusinessProfile | null) ?? null;
  const generated = await generateQualityQuestionsBatch(keywords.map((k) => k.term), profile);
  let stored = 0;
  for (const k of keywords) {
    const qs = generated.get(k.term.trim());
    if (!qs?.length) continue;
    const { error } = await supabase
      .from("keywords")
      .update({ quality_questions: toQualityQuestions(qs) })
      .eq("id", k.id)
      .eq("workspace_id", workspaceId);
    if (!error) stored++;
  }
  return stored;
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

// ---------------------------------------------------------------------------
// Adding to a plan that already exists
// ---------------------------------------------------------------------------
//
// `schedulePlan` rebuilds the whole queue from the recommendation ranking. The
// research drawer does something smaller: the person has picked specific
// keywords and wants them on the calendar without disturbing what is already
// there. So this finds the free slots at the workspace's pace and fills them,
// and refuses past the cap rather than silently dropping the tail.

/** The most planned keywords one calendar holds, across every status short of written. */
export const SCHEDULE_CAP = 60;

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
  const weekly = Math.max(0, Math.min(7, Math.floor(weeklyLimit)));
  if (weekly === 0 || count <= 0) return [];
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const step = 7 / weekly;
  const taken = new Set(occupied);
  const out: string[] = [];
  // Walk the pace grid forward until enough open days are found. Bounded so
  // a fully booked year cannot spin: past a year out, the answer is "no".
  for (let i = 0; out.length < count && i < 366 * weekly; i++) {
    const date = isoDate(new Date(start + Math.round(i * step) * DAY_MS));
    if (taken.has(date)) continue;
    taken.add(date);
    out.push(date);
  }
  return out;
}

export interface ScheduleOutcome {
  scheduled: PlannedEntry[];
  /** Keyword ids that did not fit under the cap. Reported, never dropped quietly. */
  refused: string[];
  capacity: { scheduled: number; cap: number; slots: number };
}

/**
 * Put specific keywords on the calendar.
 *
 * Marks each keyword `planned` and adds a queued calendar entry on the next
 * open day. Ids already on the calendar are skipped rather than doubled.
 * Stops at `SCHEDULE_CAP` planned entries and returns what it could not fit.
 */
export async function scheduleKeywords(
  supabase: SupabaseClient,
  workspaceId: string,
  keywordIds: string[],
  fromDate: Date = new Date(),
): Promise<ScheduleOutcome> {
  const wanted = [...new Set(keywordIds.filter(Boolean))];

  const [{ data: ws }, { data: planned }] = await Promise.all([
    supabase.from("workspaces").select("auto_generate_weekly_limit").eq("id", workspaceId).maybeSingle(),
    supabase
      .from("calendar_entries")
      .select("keyword_id, scheduled_date")
      .eq("workspace_id", workspaceId)
      .in("status", ["queue", "scheduled"]),
  ]);

  const rows = (planned ?? []) as Array<{ keyword_id: string | null; scheduled_date: string }>;
  const alreadyPlanned = new Set(rows.map((r) => r.keyword_id).filter((id): id is string => Boolean(id)));
  const occupied = rows.map((r) => r.scheduled_date);
  const existingCount = rows.length;
  const slots = Math.max(0, SCHEDULE_CAP - existingCount);

  const fresh = wanted.filter((id) => !alreadyPlanned.has(id));
  const fits = fresh.slice(0, slots);
  const refused = fresh.slice(slots);

  if (!fits.length) {
    return { scheduled: [], refused, capacity: { scheduled: existingCount, cap: SCHEDULE_CAP, slots } };
  }

  const { data: keywords, error: kwError } = await supabase
    .from("keywords")
    .select("id, term")
    .eq("workspace_id", workspaceId)
    .in("id", fits);
  if (kwError) throw new Error(kwError.message);
  const terms = new Map((keywords ?? []).map((k) => [k.id as string, k.term as string]));

  const weekly = (ws?.auto_generate_weekly_limit as number | null) ?? 1;
  const ids = fits.filter((id) => terms.has(id));
  const dates = nextOpenDates(occupied, Math.max(1, weekly), ids.length, fromDate);
  const scheduled: PlannedEntry[] = ids.slice(0, dates.length).map((id, i) => ({ keywordId: id, term: terms.get(id)!, date: dates[i] }));

  if (scheduled.length) {
    const { error } = await supabase.from("calendar_entries").insert(
      scheduled.map((p) => ({
        workspace_id: workspaceId,
        keyword_id: p.keywordId,
        keyword: p.term,
        scheduled_date: p.date,
        status: "queue",
      })),
    );
    if (error) throw new Error(error.message);
    await supabase
      .from("keywords")
      .update({ status: "planned" })
      .eq("workspace_id", workspaceId)
      .in("id", scheduled.map((p) => p.keywordId));
  }

  const total = existingCount + scheduled.length;
  return { scheduled, refused, capacity: { scheduled: total, cap: SCHEDULE_CAP, slots: Math.max(0, SCHEDULE_CAP - total) } };
}
