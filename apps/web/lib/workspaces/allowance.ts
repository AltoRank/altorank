// Server-side only: lib/billing/workspaces.ts reaches the Supabase server
// client through getQuota, so this cannot be imported by a client component.
// The pure half (labels, remaining) lives in ./slots.ts for that reason.

import { PLAN_WORKSPACE_LIMITS } from "@/lib/billing/workspaces";
import type { Quota } from "@/lib/billing/quota";
import type { SiteAllowance } from "./slots";

/**
 * Derive the site allowance from a quota already computed for the sidebar,
 * plus the workspace list already loaded, so the layout does not run the
 * quota queries a second time. Same rule as lib/billing/workspaces.ts:
 * self-host and operators have no ceiling, a plan has its tier's, and no
 * plan means one.
 */
export function siteAllowanceFrom(quota: Quota | null, used: number): SiteAllowance {
  if (!quota) return null;
  if (quota.reason === "self-host" || quota.reason === "operator") return { used, limit: null };
  const limit = quota.reason === "plan" && quota.plan ? PLAN_WORKSPACE_LIMITS[quota.plan] : PLAN_WORKSPACE_LIMITS.none;
  return { used, limit };
}
