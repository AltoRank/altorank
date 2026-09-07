// ---------------------------------------------------------------------------
// How many workspaces an account may have
// ---------------------------------------------------------------------------
//
// Articles are the meter; workspaces are not (pricing page: "metered on
// output, not seats or workspaces"). But a workspace costs before an article
// does: a crawl, PageSpeed, keyword discovery, voice training and, since
// 2026-09-02, free drafts - FREE_DRAFTS of them a month since 2026-09-06.
// With no ceiling an unpaid account could add fifty domains and get fifty of
// each. So: one site to try it on, three on
// Managed, no limit on Agency, and never a limit for self-host or operators.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlanTier } from "@/lib/stripe";
import { getQuota } from "./quota";
import { agencyCountingClient } from "./agency-client";

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
  // Agency-wide: a member scoped to one site would otherwise count one site
  // and be allowed to add another on a plan that is already full.
  const { count } = await agencyCountingClient(supabase)
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
    return a.used > 1
      ? `${a.used} workspaces exist and one is included before choosing a plan. None has been removed; choose a plan on the Billing page to add more sites.`
      : "One workspace is included before choosing a plan. Choose a plan on the Billing page to add more sites.";
  }
  // A downgrade leaves more sites than the new tier allows and deletes none of
  // them, so `used` can be past `limit`. Saying "all 3 are in use" beside a
  // list of five is the one thing this sentence must not do.
  if (a.limit !== null && a.used > a.limit) {
    return `This plan includes ${a.limit} workspaces and ${a.used} are in use. None has been removed — upgrade on the Billing page to add more.`;
  }
  return `This plan includes ${a.limit} workspaces and all ${a.limit} are in use. Upgrade on the Billing page to add more.`;
}
