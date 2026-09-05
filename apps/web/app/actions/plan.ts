"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";
import { parseStoredQuestions, type QualityQuestion } from "@/lib/keywords/questions";
import { isExpectedLength } from "@/lib/keywords/taxonomy";
import { requireAuth } from "@/lib/auth/require-auth";
import { getQuota } from "@/lib/billing/quota";
import { FREE_TIER_PACE, MAX_PACE, monthlyFromPace, normalisePace } from "@/lib/content/pace";
import { getPlanCapacity, type PlanCapacity } from "@/lib/plan/capacity";
import { paceAllowed, paceOptions, planNeededFor, type PaceOption } from "@/lib/plan/pace-options";
import { scheduleSentence } from "@/lib/plan/schedule-times";
import { PLAN_LABELS } from "@/lib/stripe";
import type { PausedMeta } from "@/lib/types";
import {
  countScheduled,
  describePlanDiff,
  ensureQuestionsFor,
  previewPlan,
  schedulePlan,
  PLAN_MAX_ENTRIES,
  type PlanDiff,
} from "@/lib/onboarding/plan";

// ---------------------------------------------------------------------------
// Editing the plan
// ---------------------------------------------------------------------------
//
// Everything a person can do to a planned keyword from the calendar: tell the
// writer something, answer its questions, move the day, take it off the plan,
// or lay the month out. Every write names the caller's active workspace as
// well as the row id: the id alone is enough for RLS (agency scope) and not
// enough for the page (workspace scope). See AGENTS.md.
//
// Nothing here publishes or approves anything.

async function scoped() {
  const supabase = await createClient();
  const workspaceId = await getScopedWorkspaceId();
  if (!workspaceId) throw new Error("No workspace is selected.");
  return { supabase, workspaceId };
}

function refresh() {
  revalidatePath("/content");
  revalidatePath("/dashboard");
}

/** The free-text brief and the length band for one keyword's article. */
export async function saveKeywordBrief(
  keywordId: string,
  input: { instructions: string; expectedLength?: string },
): Promise<void> {
  const { supabase, workspaceId } = await scoped();
  const instructions = input.instructions.trim().slice(0, 4000) || null;
  const patch: Record<string, unknown> = { instructions };
  if (input.expectedLength !== undefined) {
    if (!isExpectedLength(input.expectedLength)) throw new Error("Unknown length.");
    patch.expected_length = input.expectedLength;
  }
  const { error } = await supabase
    .from("keywords")
    .update(patch)
    .eq("id", keywordId)
    .eq("workspace_id", workspaceId);
  if (error) throw new Error(error.message);
  refresh();
}

/**
 * Store answers by question id. Only the questions already on the row are
 * touched, so a client cannot add a question the model never asked, and a
 * blank answer clears rather than stores whitespace.
 */
export async function saveKeywordAnswers(
  keywordId: string,
  answers: Record<string, string>,
): Promise<QualityQuestion[]> {
  const { supabase, workspaceId } = await scoped();
  const { data, error } = await supabase
    .from("keywords")
    .select("quality_questions")
    .eq("id", keywordId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Keyword not found in this workspace.");

  const merged = parseStoredQuestions(data.quality_questions).map((q) => {
    if (!(q.id in answers)) return q;
    const a = (answers[q.id] ?? "").trim().slice(0, 2000);
    return { ...q, answer: a || null };
  });
  const { error: saveError } = await supabase
    .from("keywords")
    .update({ quality_questions: merged })
    .eq("id", keywordId)
    .eq("workspace_id", workspaceId);
  if (saveError) throw new Error(saveError.message);
  refresh();
  return merged;
}

/**
 * The questions for a keyword, generating them if the row has none. Returns
 * whatever is stored afterwards, which is still [] when generation could not
 * produce any: the dialog says so rather than showing invented ones.
 */
export async function ensureKeywordQuestions(keywordId: string): Promise<QualityQuestion[]> {
  const { supabase, workspaceId } = await scoped();
  const read = async () => {
    const { data } = await supabase
      .from("keywords")
      .select("id, term, quality_questions")
      .eq("id", keywordId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    return data as { id: string; term: string; quality_questions: unknown } | null;
  };
  const row = await read();
  if (!row) throw new Error("Keyword not found in this workspace.");
  const current = parseStoredQuestions(row.quality_questions);
  if (current.length > 0) return current;
  await ensureQuestionsFor(supabase, workspaceId, [{ id: row.id, term: row.term }]);
  const after = await read();
  const questions = parseStoredQuestions(after?.quality_questions);
  if (questions.length) refresh();
  return questions;
}

/**
 * Take a planned keyword off the calendar. The entry goes; the keyword stays
 * tracked, stamped so the planner does not put it straight back. Only an
 * entry with no article can be removed: once written, the article is the
 * record and is managed from the Articles page.
 */
export async function removePlannedEntry(entryId: string): Promise<void> {
  const { supabase, workspaceId } = await scoped();
  const { data: entry } = await supabase
    .from("calendar_entries")
    .select("id, keyword_id, article_id")
    .eq("id", entryId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!entry) throw new Error("This entry is not on the plan.");
  if (entry.article_id) throw new Error("This article has already been written; manage it from Articles.");

  const { error } = await supabase
    .from("calendar_entries")
    .delete()
    .eq("id", entryId)
    .eq("workspace_id", workspaceId);
  if (error) throw new Error(error.message);
  if (entry.keyword_id) {
    await supabase
      .from("keywords")
      .update({ plan_excluded_at: new Date().toISOString() })
      .eq("id", entry.keyword_id as string)
      .eq("workspace_id", workspaceId);
  }
  refresh();
}

/** Move a planned entry to another day. */
export async function reschedulePlannedEntry(entryId: string, date: string): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) {
    throw new Error("Pick a date.");
  }
  const { supabase, workspaceId } = await scoped();
  const { error, count } = await supabase
    .from("calendar_entries")
    .update({ scheduled_date: date }, { count: "exact" })
    .eq("id", entryId)
    .eq("workspace_id", workspaceId)
    .is("article_id", null);
  if (error) throw new Error(error.message);
  if (!count) throw new Error("This entry cannot be moved.");
  refresh();
}

/**
 * Lay out the month for the active workspace at its own pace. Additive: it
 * keeps what is already on the calendar and fills the room left under the
 * cap, so pressing it twice does not reshuffle a plan someone has edited.
 */
export async function planMonth(): Promise<{ planned: number; scheduled: number; max: number }> {
  const { supabase, workspaceId } = await scoped();
  const { data: ws } = await supabase
    .from("workspaces")
    .select("auto_generate_weekly_limit")
    .eq("id", workspaceId)
    .maybeSingle();
  const pace = (ws?.auto_generate_weekly_limit as number | null) ?? FREE_TIER_PACE;
  const planned = await schedulePlan(supabase, workspaceId, pace, { mode: "top-up" });
  refresh();
  return { planned: planned.length, scheduled: await countScheduled(supabase, workspaceId), max: PLAN_MAX_ENTRIES };
}

// ---------------------------------------------------------------------------
// The Articles-plan control (pace, publishing days, re-plan)
// ---------------------------------------------------------------------------

/**
 * The Articles-plan control on the calendar.
 *
 * Three settings that were three screens - the pace slider and the cadence
 * form on the workspace page, the plan itself only visible as chips on the
 * calendar - read and written as one thing, from the calendar, where the
 * consequence is on screen. Every write here is the same write those screens
 * do: `auto_generate_weekly_limit` through `normalisePace`, the cadence row
 * through the same upsert, the calendar through `schedulePlan`.
 */

export interface ArticlesPlanState {
  workspaceId: string;
  pace: number;
  /** Weekdays (0 = Sunday) the cadence publishes on; empty when none chosen. */
  days: number[];
  cadenceEnabled: boolean;
  publishTime: string | null;
  timezone: string | null;
  options: PaceOption[];
  capacity: PlanCapacity;
  /** "Articles are generated around 07:00 UTC and published … at 09:00 UTC." */
  schedule: string;
  status: string;
  pausedMeta: PausedMeta | null;
}

async function ownWorkspace(workspaceId: string) {
  const { agencyId, user } = await requireAuth();
  const supabase = await createClient();
  const { data: ws, error } = await supabase
    .from("workspaces")
    .select("id, agency_id, status, auto_generate_weekly_limit, paused_meta")
    .eq("id", workspaceId)
    .eq("agency_id", agencyId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!ws) throw new Error("That site is not in your account.");
  return { supabase, agencyId, user, ws };
}

async function readCadence(supabase: Awaited<ReturnType<typeof createClient>>, workspaceId: string) {
  const { data } = await supabase
    .from("publishing_cadences")
    .select("days_of_week, enabled, publish_time, timezone")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  return data as { days_of_week: number[]; enabled: boolean; publish_time: string; timezone: string } | null;
}

export async function getArticlesPlanState(workspaceId: string): Promise<ArticlesPlanState> {
  const { supabase, agencyId, user, ws } = await ownWorkspace(workspaceId);
  const [cadence, quota, capacity] = await Promise.all([
    readCadence(supabase, workspaceId),
    getQuota(supabase, agencyId, user.email ?? null),
    getPlanCapacity(supabase, workspaceId),
  ]);
  return {
    workspaceId,
    pace: (ws.auto_generate_weekly_limit as number | null) ?? capacity.weeklyLimit,
    days: cadence?.enabled ? [...(cadence.days_of_week ?? [])].sort((a, b) => a - b) : [],
    cadenceEnabled: cadence?.enabled ?? false,
    publishTime: cadence?.publish_time?.slice(0, 5) ?? null,
    timezone: cadence?.timezone ?? null,
    options: paceOptions(quota),
    capacity,
    schedule: scheduleSentence(),
    status: ws.status as string,
    pausedMeta: (ws.paused_meta ?? null) as PausedMeta | null,
  };
}

function cleanDays(days: unknown): number[] {
  if (!Array.isArray(days)) return [];
  const set = new Set<number>();
  for (const d of days) if (Number.isInteger(d) && d >= 0 && d <= 6) set.add(d as number);
  return [...set].sort((a, b) => a - b);
}

/** What applying `pace` and `days` would do to the calendar. Reads only. */
export async function previewArticlesPlan(
  workspaceId: string,
  requestedPace: unknown,
  requestedDays: unknown,
): Promise<{ diff: PlanDiff; sentence: string; planned: number }> {
  const { supabase } = await ownWorkspace(workspaceId);
  const pace = normalisePace(requestedPace);
  if (pace === null) throw new Error(`Pick a number of articles a week between 0 and ${MAX_PACE}.`);
  const days = cleanDays(requestedDays);
  const { next, diff } = await previewPlan(supabase, workspaceId, pace, { daysOfWeek: days.length ? days : undefined });
  return { diff, sentence: describePlanDiff(diff), planned: next.length };
}

/**
 * Set the pace and the publishing days, then re-plan.
 *
 * The plan check is enforced here, not only drawn in the popover: the option
 * list says "Needs the Managed plan" as a courtesy, this is what makes it true
 * for a request that skipped the UI.
 */
export async function applyArticlesPlan(
  workspaceId: string,
  requestedPace: unknown,
  requestedDays: unknown,
): Promise<{ pace: number; days: number[]; planned: number; sentence: string }> {
  const { supabase, agencyId, user, ws } = await ownWorkspace(workspaceId);
  const pace = normalisePace(requestedPace);
  if (pace === null) throw new Error(`Pick a number of articles a week between 0 and ${MAX_PACE}.`);
  const days = cleanDays(requestedDays);

  const quota = await getQuota(supabase, agencyId, user.email ?? null);
  if (!paceAllowed(pace, quota)) {
    const needs = PLAN_LABELS[planNeededFor(monthlyFromPace(pace))];
    throw new Error(`${pace} a week is about ${monthlyFromPace(pace)} a month, which needs the ${needs} plan. Choose one on the Billing page.`);
  }

  // Computed before the writes so the sentence describes the plan as the
  // person saw it, not the plan after it has been replaced.
  const { diff } = await previewPlan(supabase, workspaceId, pace, { daysOfWeek: days.length ? days : undefined });

  if (pace !== ((ws.auto_generate_weekly_limit as number | null) ?? null)) {
    const { error } = await supabase
      .from("workspaces")
      .update({ auto_generate_weekly_limit: pace })
      .eq("id", workspaceId)
      .eq("agency_id", agencyId);
    if (error) throw new Error(error.message);
  }

  // Only the days and the switch. Time and timezone stay whatever the
  // workspace settings page set (defaults 10:00 Europe/Rome from migration
  // 003); this control has no opinion about them.
  const { error: cadenceError } = await supabase.from("publishing_cadences").upsert(
    {
      workspace_id: workspaceId,
      days_of_week: days,
      enabled: days.length > 0,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id" },
  );
  if (cadenceError) throw new Error(cadenceError.message);

  const plan = await schedulePlan(supabase, workspaceId, pace, { daysOfWeek: days.length ? days : undefined });

  revalidatePath("/content");
  revalidatePath(`/workspaces/${workspaceId}`);
  revalidatePath("/dashboard");
  return { pace, days, planned: plan.length, sentence: describePlanDiff(diff) };
}
