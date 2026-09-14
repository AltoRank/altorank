import { distinctOnboardingTopics } from "./distinct-topics";
import { e2eStubsEnabled } from "@/lib/e2e/stubs";
import { languageCodeOf } from "@/lib/keyword-research/locale";
import { qualifyOpportunities, serpOverlap, type Opportunity } from "@/lib/keyword-research/opportunity";
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

import { PLAN_MAX_ENTRIES, buildPlan, diffPlan, nextOpenDates, type PlannedEntry, type PlanDiff, monthlyTarget, DAY_MS, isoDate } from "./plan-calendar";
export { PLAN_HORIZON_DAYS, PLAN_MAX_ENTRIES, buildPlan, diffPlan, nextOpenDates, type PlannedEntry, type Weekday, type PlanDiff, monthlyTarget, describePlanDiff } from "./plan-calendar";

type ExistingEntry = {
  keyword_id: string | null;
  keyword: string | null;
  scheduled_date: string;
  article_id: string | null;
  status: "queue" | "scheduled";
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

export interface PlanOptions {
  from?: Date;
  /** Weekdays the site publishes on, from its cadence. Absent = any day. */
  daysOfWeek?: readonly number[];
  /**
   * `replace` (the default, what onboarding does) drops queued entries that
   * never became an article and lays the month out again. `top-up` keeps every
   * existing entry - including ones a person moved - and only appends, from the
   * day after the last one, until the month holds what the pace promises. The
   * cron uses `top-up`; a plan someone has edited must not be rewritten under
   * them. `fill-month` preserves those entries while filling unused slots
   * inside the thirty-day window beginning at `from`.
   */
  mode?: "replace" | "top-up" | "fill-month";
  maxEntries?: number;
  distinctTasks?: boolean;
  retryPending?: boolean;
  /** Owner interviews are optional and can be generated when the topic is opened. */
  deferQuestions?: boolean;
  onProgress?: NonNullable<Parameters<typeof recommendKeywords>[2]>["onProgress"];
}

/**
 * The plan `schedulePlan` would write, computed without writing it. One
 * function so the preview and the write cannot disagree about the room left,
 * the keywords a person removed from the planner, or the entries already taken.
 */
async function planFor(
  supabase: SupabaseClient,
  workspaceId: string,
  weeklyLimit: number,
  opts: PlanOptions,
): Promise<{ plan: PlannedEntry[]; recs: KeywordRecommendation[] }> {
  const mode = opts.mode ?? "replace";
  const all = await scheduledEntries(supabase, workspaceId);
  // In replace mode the unfulfilled queue is about to be dropped, so it does
  // not count against the cap and its keywords are free to be planned again.
  const existing = mode === "replace" ? all.filter((e) => e.status !== "queue" || e.article_id) : all;
  const room = PLAN_MAX_ENTRIES - existing.length;
  if (room <= 0 || opts.maxEntries === 0) return { plan: [], recs: [] };

  const { data: excludedRows } = await supabase
    .from("keywords")
    .select("id")
    .eq("workspace_id", workspaceId)
    .not("plan_excluded_at", "is", null);
  const excluded = new Set((excludedRows ?? []).map((r) => r.id as string));
  const takenIds = new Set(existing.map((e) => e.keyword_id).filter(Boolean) as string[]);
  const takenTerms = new Set(existing.map((e) => (e.keyword ?? "").toLowerCase()).filter(Boolean));

  // The limit is applied after scoring, across every action. At 80 a site
  // that already ranks for 80+ terms filled the list with "skip: already
  // ranking" rows and the one writable keyword scored below them was never
  // seen (buttondown.com, 2026-09-07: 99 skips, 2 hand-added terms, 1
  // planned). Ask for the whole set; the planner filters to writable itself.
  let recs = (await recommendKeywords(supabase, workspaceId, { limit: 1000, qualify: true, distinctTasks: opts.distinctTasks, retryPending: opts.retryPending, ...(opts.onProgress ? {onProgress: opts.onProgress} : {}) })).filter(
    (r) => !excluded.has(r.keywordId) && !takenIds.has(r.keywordId) && !takenTerms.has(r.term.toLowerCase()),
  );

  if (opts.distinctTasks && !e2eStubsEnabled()) {
    // Existing drafts and accepted topics get first priority in a semantic
    // group. Otherwise topping up reintroduces a synonym rejected during the
    // first-choice pass merely because its SERP URLs differ.
    const covered = existing.length ? await supabase.from("keywords").select("id, term, opportunity")
      .eq("workspace_id", workspaceId).in("id", [...takenIds]) : { data: [], error: null };
    if (covered.error) throw covered.error;
    const anchors = (covered.data ?? []).map((keyword) => ({
      keywordId: keyword.id, term: keyword.term, opportunity: keyword.opportunity,
      action: "write", quality: "ok", qualityNote: null, volume: null, difficulty: null, intent: "info",
      score: 0, reasons: [], existingArticleId: null, currentPosition: null, impressions: null,
    } as KeywordRecommendation));
    recs = (await distinctOnboardingTopics([...anchors, ...recs], {supabase,workspaceId}))
      .filter((rec) => !takenIds.has(rec.keywordId));
  }

  let start = opts.from ?? new Date();
  let maxEntries = Math.min(room, opts.maxEntries ?? room);
  if (mode === "top-up") {
    const unwritten = existing.filter((e) => !e.article_id).length;
    maxEntries = Math.min(maxEntries, Math.max(0, monthlyTarget(weeklyLimit) - unwritten));
    if (maxEntries === 0) return { plan: [], recs };
    const last = existing.map((e) => e.scheduled_date).sort().at(-1);
    if (last) {
      const next = new Date(new Date(`${last}T00:00:00Z`).getTime() + DAY_MS);
      if (next > start) start = next;
    }
  }

  if (mode === "fill-month") {
    const end = isoDate(new Date(start.getTime() + 30 * DAY_MS));
    const inMonth = existing.filter((e) => e.scheduled_date >= isoDate(start) && e.scheduled_date < end);
    maxEntries = Math.min(maxEntries, Math.max(0, monthlyTarget(weeklyLimit) - inMonth.length));
  }

  const plan = buildPlan(recs, {
    weeklyLimit,
    from: start,
    maxEntries,
    daysOfWeek: opts.daysOfWeek,
    occupied: existing.map((e) => e.scheduled_date).filter(Boolean) as string[],
  });
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
  const [{ plan: next }, existing] = await Promise.all([
    planFor(supabase, workspaceId, weeklyLimit, opts),
    readPlannedEntries(supabase, workspaceId),
  ]);
  return { next, diff: diffPlan(existing, next) };
}

/**
 * Write the plan for a workspace. See `PlanOptions.mode` for what is kept.
 *
 * Keywords a person removed from the planner are skipped in both modes.
 */
export async function schedulePlan(
  supabase: SupabaseClient,
  workspaceId: string,
  weeklyLimit: number,
  opts: PlanOptions = {},
): Promise<PlannedEntry[]> {
  const mode = opts.mode ?? "replace";
  const { plan, recs } = await planFor(supabase, workspaceId, weeklyLimit, opts);
  if (mode === "replace") {
    await supabase
      .from("calendar_entries")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("status", "queue")
      .is("article_id", null);
  }
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

  // The dashboard counts "in the content plan" from keywords.status, and only
  // the research drawer used to set it, so a wizard plan read as 0 planned.
  // Only rows still "new" move: a keyword already drafting keeps its state.
  await supabase
    .from("keywords")
    .update({ status: "planned" })
    .eq("workspace_id", workspaceId)
    .eq("status", "new")
    .in("id", plan.map((p) => p.keywordId));

  // Best-effort: a plan is written even if the shape or the questions fail.
  try {
    const intents = new Map(recs.map((r) => [r.keywordId, r.intent]));
    await decoratePlannedKeywords(supabase, workspaceId, plan.map((p) => p.keywordId), intents, { deferQuestions: opts.deferQuestions });
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
  options: { deferQuestions?: boolean } = {},
): Promise<{ classified: number; questioned: number }> {
  if (keywordIds.length === 0) return { classified: 0, questioned: 0 };
  const { data } = await supabase
    .from("keywords")
    .select("id, term, intent, article_subtype, quality_questions, opportunity")
    .eq("workspace_id", workspaceId)
    .in("id", keywordIds);
  const rows = (data ?? []) as Array<{ id: string; term: string; intent: KeywordIntent | null; article_subtype: string | null; quality_questions: unknown; opportunity?: { status?: string; angle?: string } }>;

  let classified = 0;
  for (const row of rows) {
    if (row.article_subtype) continue;
    const angle = row.opportunity?.status === "qualified" ? row.opportunity.angle : null;
    const shape = classifyKeyword(angle || row.term, intents.get(row.id) ?? row.intent);
    await supabase.from("keywords").update(shape).eq("id", row.id).eq("workspace_id", workspaceId);
    classified++;
  }

  const questioned = options.deferQuestions ? 0 : await ensureQuestionsFor(
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

/**
 * Mark a planned entry as written, and its keyword as drafting.
 *
 * `wrote` is what the run actually produced. It differs from the entry's own
 * keyword when the plan named a term the recommender now refuses - out of
 * reach, provider noise, or arguing against what the business sells - and the
 * run wrote the best available keyword into that day's slot instead. The entry
 * is rewritten to say so, because a calendar that still shows the refused term
 * beside the article is lying about what happened.
 */
export async function fulfilPlannedEntry(
  supabase: SupabaseClient,
  entryId: string,
  articleId: string,
  wrote?: { term: string; keywordId: string | null },
): Promise<void> {
  const patch: Record<string, unknown> = { article_id: articleId, status: "scheduled" };
  if (wrote) {
    patch.keyword = wrote.term;
    if (wrote.keywordId) patch.keyword_id = wrote.keywordId;
  }
  const { data, error } = await supabase
    .from("calendar_entries")
    .update(patch)
    .eq("id", entryId)
    .select("keyword_id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (data?.keyword_id) {
    await supabase.from("keywords").update({ status: "drafting" }).eq("id", data.keyword_id);
  }
}

/**
 * Close queued entries whose keyword has already been written.
 *
 * `duePlannedKeyword` only skips entries carrying an `article_id`, and only
 * the planned path ever sets one. An article the live queue picked for a term
 * that also sits in the calendar leaves that entry open, so the plan comes
 * back for the same keyword on its scheduled day and writes it a second time.
 * qasimcode.com had two of these queued on 2026-09-09, each for a keyword it
 * had already published.
 *
 * Attaches the existing article and returns how many entries it closed.
 */
export async function closeCoveredEntries(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<number> {
  const { data: open } = await supabase
    .from("calendar_entries")
    .select("id, keyword_id, keyword")
    .eq("workspace_id", workspaceId)
    .eq("status", "queue")
    .is("article_id", null);
  const entries = (open ?? []) as { id: string; keyword_id: string | null; keyword: string | null }[];
  if (entries.length === 0) return 0;

  const { data: written } = await supabase
    .from("articles")
    .select("id, keyword_id, keyword")
    .eq("workspace_id", workspaceId);
  const articles = (written ?? []) as { id: string; keyword_id: string | null; keyword: string | null }[];
  if (articles.length === 0) return 0;

  const byKeywordId = new Map<string, string>();
  const byTerm = new Map<string, string>();
  for (const a of articles) {
    if (a.keyword_id && !byKeywordId.has(a.keyword_id)) byKeywordId.set(a.keyword_id, a.id);
    const term = a.keyword?.trim().toLowerCase();
    if (term && !byTerm.has(term)) byTerm.set(term, a.id);
  }

  let closed = 0;
  for (const e of entries) {
    const articleId =
      (e.keyword_id ? byKeywordId.get(e.keyword_id) : undefined) ??
      byTerm.get(e.keyword?.trim().toLowerCase() ?? "");
    if (!articleId) continue;
    await fulfilPlannedEntry(supabase, e.id, articleId);
    closed += 1;
  }
  return closed;
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

/**
 * The next `count` open dates at `weeklyLimit` a week, starting at `from`.
 *
 * `occupied` lists the dates already carrying a planned entry; a day is open
 * while it holds fewer entries than the pace allows (one a day at 7/week,
 * one every seventh day at 1/week). Pure, so the fill order can be tested.
 */
export interface ScheduleOutcome {
  scheduled: PlannedEntry[];
  /** Keyword ids that did not fit under the cap. Reported, never dropped quietly. */
  refused: string[];
  reasons?: Record<string, string>;
  capacity: { scheduled: number; cap: number; slots: number };
}

/**
 * Put specific keywords on the calendar.
 *
 * Marks each keyword `planned` and adds a queued calendar entry on the next
 * open day. Ids already on the calendar are skipped rather than doubled.
 * Stops at `PLAN_MAX_ENTRIES` planned entries and returns what it could not fit.
 */
export async function scheduleKeywords(
  supabase: SupabaseClient,
  workspaceId: string,
  keywordIds: string[],
  fromDate: Date = new Date(),
): Promise<ScheduleOutcome> {
  const wanted = [...new Set(keywordIds.filter(Boolean))];

  const [{ data: ws }, { data: planned }] = await Promise.all([
    supabase.from("workspaces").select("auto_generate_weekly_limit, business_profile, domain, language, location_code").eq("id", workspaceId).maybeSingle(),
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
  const slots = Math.max(0, PLAN_MAX_ENTRIES - existingCount);

  const fresh = wanted.filter((id) => !alreadyPlanned.has(id));
  const fits = fresh.slice(0, slots);
  const refused = fresh.slice(slots);

  if (!fits.length) {
    return { scheduled: [], refused, capacity: { scheduled: existingCount, cap: PLAN_MAX_ENTRIES, slots } };
  }

  const { data: keywords, error: kwError } = await supabase
    .from("keywords")
    .select("id, term, source_url, opportunity")
    .eq("workspace_id", workspaceId)
    .in("id", fits);
  if (kwError) throw new Error(kwError.message);
  const terms = new Map((keywords ?? []).map((k) => [k.id as string, k.term as string]));

  const weekly = (ws?.auto_generate_weekly_limit as number | null) ?? 1;
  const qualified = await qualifyOpportunities(supabase, workspaceId, keywords ?? [], { domain: ws?.domain ?? "", business: ws?.business_profile ?? null, languageCode: languageCodeOf(ws?.language), locationCode: ws?.location_code ?? 2840 });
  const reasons: Record<string, string> = {};
  const accepted: Opportunity[] = [];
  const ids = fits.filter((id) => {
    const evidence = qualified.get(id);
    const duplicate = evidence && accepted.some((other) => serpOverlap(evidence.organicUrls ?? [], other.organicUrls ?? []) >= 0.5);
    if (!terms.has(id) || evidence?.status !== "qualified" || duplicate) {
      refused.push(id);
      reasons[id] = duplicate ? "Another selected article covers the same search intent." : evidence?.reason ?? "Buyer fit and search evidence are still pending.";
      return false;
    }
    accepted.push(evidence);
    return true;
  });
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
  return { scheduled, refused, reasons, capacity: { scheduled: total, cap: PLAN_MAX_ENTRIES, slots: Math.max(0, PLAN_MAX_ENTRIES - total) } };
}
