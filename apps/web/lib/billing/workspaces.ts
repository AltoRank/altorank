// ---------------------------------------------------------------------------
// How many workspaces an account may have
// ---------------------------------------------------------------------------
//
// Articles are the meter; workspaces are not (pricing page: "metered on
// output, not seats or workspaces"). But a workspace costs before an article
// does: a crawl, PageSpeed, keyword discovery, voice training and, since
// 2026-09-02, one free draft. With no ceiling an unpaid account could add
// fifty domains and get fifty of each. So: one site to try it on, three on
// Managed, no limit on Agency, and never a limit for self-host or operators.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlanTier } from "@/lib/stripe";
import { getQuota } from "./quota";

/** null = unlimited. */
export const PLAN_WORKSPACE_LIMITS: Record<PlanTier | "none", number | null> = {
  none: 1,
  starter: 3,
  growth: null,
  scale: null,
};

export type WorkspaceAllowance = {
  limit: number | null;
  used: number;
  remaining: number | null;
  reason: "self-host" | "operator" | "plan" | "no-plan";
  plan: PlanTier | null;
};

export async function getWorkspaceAllowance(
  supabase: SupabaseClient,
  agencyId: string,
  userEmail?: string | null,
): Promise<WorkspaceAllowance> {
  const quota = await getQuota(supabase, agencyId, userEmail);
  const { count } = await supabase
    .from("workspaces")
    .select("id", { count: "exact", head: true })
    .eq("agency_id", agencyId);
  const used = count ?? 0;

  if (quota.reason === "self-host" || quota.reason === "operator") {
    return { limit: null, used, remaining: null, reason: quota.reason, plan: null };
  }
  const limit = quota.reason === "plan" && quota.plan ? PLAN_WORKSPACE_LIMITS[quota.plan] : PLAN_WORKSPACE_LIMITS.none;
  return {
    limit,
    used,
    remaining: limit === null ? null : Math.max(0, limit - used),
    reason: quota.reason,
    plan: quota.plan,
  };
}

export function workspaceLimitMessage(a: WorkspaceAllowance): string {
  if (a.reason === "no-plan") {
    return "One workspace is included before choosing a plan. Choose a plan on the Billing page to add more sites.";
  }
  return `This plan includes ${a.limit} workspaces and all ${a.limit} are in use. Upgrade on the Billing page to add more.`;
}
