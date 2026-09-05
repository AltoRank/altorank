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

/**
 * Spread the queue across the horizon at `weeklyLimit` articles a week.
 *
 * 7 a week is one a day; 1 a week is every seventh day; anything in between
 * spaces entries evenly rather than front-loading the week. Weekends are not
 * skipped: a blog that publishes daily publishes on Saturday too, and the
 * cadence table already exists for people who want specific days.
 *
 * `maxEntries` lets a caller that already holds some of the 60 ask only for
 * the room that is left.
 */
export function buildPlan(
  recommendations: Pick<KeywordRecommendation, "keywordId" | "term" | "action" | "quality">[],
  opts: { weeklyLimit: number; from?: Date; horizonDays?: number; maxEntries?: number },
): PlannedEntry[] {
  const weekly = Math.max(0, Math.min(7, Math.floor(opts.weeklyLimit)));
  if (weekly === 0) return [];
  const horizon = opts.horizonDays ?? PLAN_HORIZON_DAYS;
  const from = opts.from ?? new Date();
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const cap = Math.max(0, Math.min(PLAN_MAX_ENTRIES, opts.maxEntries ?? PLAN_MAX_ENTRIES));
  const count = Math.min(cap, Math.ceil((weekly * horizon) / 7));
  const step = 7 / weekly;

  const usable = recommendations.filter((r) => r.action === "write" && r.quality === "ok" && r.keywordId);
  const out: PlannedEntry[] = [];
  for (let i = 0; i < Math.min(count, usable.length); i++) {
    const offset = Math.round(i * step);
    if (offset >= horizon) break;
    out.push({ keywordId: usable[i].keywordId, term: usable[i].term, date: isoDate(new Date(start + offset * DAY_MS)) });
  }
  return out;
}

type ExistingEntry = { keyword_id: string | null; keyword: string | null; scheduled_date: string; article_id: string | null };

/** Everything on the calendar that still counts against the cap. */
async function scheduledEntries(supabase: SupabaseClient, workspaceId: string): Promise<ExistingEntry[]> {
  const { data } = await supabase
    .from("calendar_entries")
    .select("keyword_id, keyword, scheduled_date, article_id")
    .eq("workspace_id", workspaceId)
    .in("status", ["queue", "scheduled"]);
  return (data ?? []) as ExistingEntry[];
}

/** Scheduled keywords for the planner header: "N of 60". */
export async function countScheduled(supabase: SupabaseClient, workspaceId: string): Promise<number> {
  return (await scheduledEntries(supabase, workspaceId)).length;
}

/**
 * Write the plan for a workspace.
 *
 * `replace` (the default, what onboarding does) drops queued entries that
 * never became an article and lays the month out again. `top-up` keeps every
 * existing entry - including ones a person moved - and only appends, from the
 * day after the last one, until the month holds what the pace promises. The
 * cron uses `top-up`; a plan someone has edited must not be rewritten under
 * them.
 *
 * Keywords a person removed from the planner are skipped in both modes.
 */
export async function schedulePlan(
  supabase: SupabaseClient,
  workspaceId: string,
  weeklyLimit: number,
  from: Date = new Date(),
  opts: { mode?: "replace" | "top-up" } = {},
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
  const room = PLAN_MAX_ENTRIES - existing.length;
  if (room <= 0) return [];

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

  let start = from;
  let maxEntries = room;
  if (mode === "top-up") {
    const unwritten = existing.filter((e) => !e.article_id).length;
    maxEntries = Math.min(room, Math.max(0, monthlyTarget(weeklyLimit) - unwritten));
    if (maxEntries === 0) return [];
    const last = existing.map((e) => e.scheduled_date).sort().at(-1);
    if (last) {
      const next = new Date(new Date(`${last}T00:00:00Z`).getTime() + DAY_MS);
      if (next > start) start = next;
    }
  }

  const plan = buildPlan(recs, { weeklyLimit, from: start, maxEntries });
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
