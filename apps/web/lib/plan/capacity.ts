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
// `monthlyTarget` is the pace in the unit the plan is sold in. The account's
// monthly quota (lib/billing/quota.ts) still bounds the total across sites;
// that is a different question and is answered there.

import type { SupabaseClient } from "@supabase/supabase-js";
import { monthlyFromPace, PAID_DEFAULT_PACE } from "@/lib/content/pace";
import { PLAN_MAX_ENTRIES } from "@/lib/onboarding/plan";

export interface PlanCapacity {
  cap: number;
  /** Planned keywords with no article yet. */
  scheduled: number;
  /** cap - scheduled, never negative. */
  available: number;
  weeklyLimit: number;
  monthlyTarget: number;
}

/** The arithmetic, separate from the reads so it can be tested. */
export function computeCapacity(input: {
  scheduled: number;
  weeklyLimit: number | null | undefined;
  cap?: number;
}): PlanCapacity {
  const cap = input.cap ?? PLAN_MAX_ENTRIES;
  const scheduled = Math.max(0, Math.floor(input.scheduled));
  const weeklyLimit = Math.max(0, Math.floor(input.weeklyLimit ?? PAID_DEFAULT_PACE));
  return {
    cap,
    scheduled,
    available: Math.max(0, cap - scheduled),
    weeklyLimit,
    monthlyTarget: monthlyFromPace(weeklyLimit),
  };
}

/**
 * Capacity for one workspace. Pass the caller's client so RLS applies; the
 * workspace id is required because there is no account-wide plan.
 */
export async function getPlanCapacity(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<PlanCapacity> {
  const [{ data: ws }, { count }] = await Promise.all([
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
  ]);
  return computeCapacity({
    scheduled: count ?? 0,
    weeklyLimit: (ws?.auto_generate_weekly_limit as number | null | undefined) ?? null,
  });
}
