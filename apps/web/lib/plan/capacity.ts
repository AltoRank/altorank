// ---------------------------------------------------------------------------
// How much room a site's plan has
// ---------------------------------------------------------------------------
//
// One answer to "how many articles can this site still schedule", so the
// Articles-plan control, the keyword research drawer and anything else that
// offers to put a keyword on the calendar quote the same number. The research
// drawer (Track F) computes its own today; it should import this instead.
//
// Two different ceilings meet here and they are easy to confuse:
//
//   cap            how many keywords may sit in the plan at once, unwritten.
//                  Sixty, matching the competitor's hard cap and twice the
//                  thirty-day horizon buildPlan fills, so a person who has
//                  hand-picked more than a month of topics is not refused.
//   weeklyLimit    how fast the generator works through them
//                  (workspaces.auto_generate_weekly_limit, lib/content/pace.ts).
//
// A scheduled improvement - a rewrite of a page that already ranks, from
// `refresh_tasks` - holds a slot exactly as a planned keyword does: it sits on
// a calendar day and spends one of the week's articles (lib/plan/pace-budget).
// So it is counted here, and the copy says both numbers ("28 articles + 2
// improvements") rather than one total that hides the trade-off.
//
// `monthlyTarget` is the pace in the unit the plan is sold in. The account's
// monthly quota (lib/billing/quota.ts) still bounds the total across sites;
// that is a different question and is answered there.

import type { SupabaseClient } from "@supabase/supabase-js";
import { monthlyFromPace, PAID_DEFAULT_PACE } from "@/lib/content/pace";
import { PLAN_MAX_ENTRIES } from "@/lib/onboarding/plan";

export interface PlanCapacity {
  cap: number;
  /** Slots held: planned keywords (written this month or not) plus scheduled improvements. */
  scheduled: number;
  /** The keyword half of `scheduled`. */
  articles: number;
  /** The improvement half of `scheduled`: rewrites scheduled or running. */
  improvements: number;
  /** cap - scheduled, never negative. */
  available: number;
  weeklyLimit: number;
  monthlyTarget: number;
}

/** The arithmetic, separate from the reads so it can be tested. */
export function computeCapacity(input: {
  /** Planned keyword entries. */
  scheduled: number;
  /** Scheduled improvements; omitted means none were counted, and reads as 0. */
  improvements?: number;
  weeklyLimit: number | null | undefined;
  cap?: number;
}): PlanCapacity {
  const cap = input.cap ?? PLAN_MAX_ENTRIES;
  const articles = Math.max(0, Math.floor(input.scheduled));
  const improvements = Math.max(0, Math.floor(input.improvements ?? 0));
  const scheduled = articles + improvements;
  const weeklyLimit = Math.max(0, Math.floor(input.weeklyLimit ?? PAID_DEFAULT_PACE));
  return {
    cap,
    scheduled,
    articles,
    improvements,
    available: Math.max(0, cap - scheduled),
    weeklyLimit,
    monthlyTarget: monthlyFromPace(weeklyLimit),
  };
}

/**
 * "3 articles + 1 improvement", or just "3 articles" when no rewrite is
 * scheduled - the second term appears only when it is a fact, so a site that
 * never turned improvements on does not read "+ 0 improvements" everywhere.
 */
export function describeSlots(articles: number, improvements: number): string {
  const a = `${articles} ${articles === 1 ? "article" : "articles"}`;
  if (improvements <= 0) return a;
  return `${a} + ${improvements} ${improvements === 1 ? "improvement" : "improvements"}`;
}

/**
 * Capacity for one workspace. Pass the caller's client so RLS applies; the
 * workspace id is required because there is no account-wide plan.
 */
export async function getPlanCapacity(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<PlanCapacity> {
  const [{ data: ws }, { count }, { count: improvements }] = await Promise.all([
    supabase
      .from("workspaces")
      .select("auto_generate_weekly_limit")
      .eq("id", workspaceId)
      .maybeSingle(),
    supabase
      .from("calendar_entries")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      // The same rows scheduleKeywords checks against the cap: planned and
      // already written both hold a slot this month.
      .in("status", ["queue", "scheduled"]),
    supabase
      .from("refresh_tasks")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      // Still to run. A finished rewrite is an execution awaiting review, and
      // its slot was spent the day it ran.
      .in("status", ["scheduled", "running"]),
  ]);
  return computeCapacity({
    scheduled: count ?? 0,
    improvements: improvements ?? 0,
    weeklyLimit: (ws?.auto_generate_weekly_limit as number | null | undefined) ?? null,
  });
}
