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

/**
 * Spread the queue across the horizon at `weeklyLimit` articles a week.
 *
 * 7 a week is one a day; 1 a week is every seventh day; anything in between
 * spaces entries evenly rather than front-loading the week. Weekends are not
 * skipped: a blog that publishes daily publishes on Saturday too, and the
 * cadence table already exists for people who want specific days.
 */
export function buildPlan(
  recommendations: Pick<KeywordRecommendation, "keywordId" | "term" | "action" | "quality">[],
  opts: { weeklyLimit: number; from?: Date; horizonDays?: number },
): PlannedEntry[] {
  const weekly = Math.max(0, Math.min(7, Math.floor(opts.weeklyLimit)));
  if (weekly === 0) return [];
  const horizon = opts.horizonDays ?? PLAN_HORIZON_DAYS;
  const from = opts.from ?? new Date();
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const count = Math.min(PLAN_MAX_ENTRIES, Math.ceil((weekly * horizon) / 7));
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

/**
 * Write the plan for a workspace. Idempotent: queued entries that never became
 * an article are replaced, entries that did are left alone.
 */
export async function schedulePlan(
  supabase: SupabaseClient,
  workspaceId: string,
  weeklyLimit: number,
  from: Date = new Date(),
): Promise<PlannedEntry[]> {
  const recs = await recommendKeywords(supabase, workspaceId, { limit: 60 });
  const plan = buildPlan(recs, { weeklyLimit, from });
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
