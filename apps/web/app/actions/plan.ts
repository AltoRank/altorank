"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { getQuota } from "@/lib/billing/quota";
import { normalisePace, MAX_PACE } from "@/lib/content/pace";
import { getPlanCapacity, type PlanCapacity } from "@/lib/plan/capacity";
import { paceAllowed, paceOptions, planNeededFor, type PaceOption } from "@/lib/plan/pace-options";
import { monthlyFromPace } from "@/lib/content/pace";
import { scheduleSentence } from "@/lib/plan/schedule-times";
import { describePlanDiff, previewPlan, schedulePlan, type PlanDiff } from "@/lib/onboarding/plan";
import { PLAN_LABELS } from "@/lib/stripe";
import type { PausedMeta } from "@/lib/types";

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
