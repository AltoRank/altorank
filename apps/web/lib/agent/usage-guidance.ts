import type { Quota } from "@/lib/billing/quota";

/**
 * What GET /usage tells an agent while drafts remain.
 *
 * It said "N of 7 included drafts remain this month" to an account with no
 * plan, whose free drafts are a one-time allowance that never resets
 * (migration 083) - so an agent could plan to wait for a refill that never
 * comes. On a plan the count really is this month's.
 */
export function usageGuidance(quota: Pick<Quota, "reason" | "limit" | "remaining">): string {
  if (quota.reason === "no-plan") {
    return `${quota.remaining} of the account's one-time ${quota.limit} free drafts remain; they do not reset. Approving or publishing needs a plan. Say so before you spend several.`;
  }
  return `${quota.remaining} of ${quota.limit} included drafts remain this month. Say so before you spend several.`;
}
