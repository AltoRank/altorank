// ---------------------------------------------------------------------------
// Article quota: what the plan includes, what this month has used
// ---------------------------------------------------------------------------
//
// The pricing page sells "100 articles / month included" and "400 articles /
// month included", and until this file nothing counted either. An unenforced
// limit is a price the product does not actually charge, and an uncounted one
// cannot even be displayed.
//
// Shape of the rule:
//
//   Self-host (no STRIPE_SECRET_KEY)   unlimited. The free tier's deal is
//                                      "your infrastructure, your API keys";
//                                      metering someone else's Anthropic bill
//                                      would be absurd.
//   Cloud, active plan                 the tier's included volume, per
//                                      calendar month.
//   Cloud, no active plan              zero. There is no trial (POSITIONING.md)
//                                      and a courtesy allowance would be one.
//   Operator accounts                  unlimited, so dogfooding does not eat
//                                      a customer-shaped quota.
//
// Counting is by articles *created* this calendar month across the agency's
// workspaces, cron and manual alike: generation is the metered cost either
// way. Deletes free quota back; that is acceptable at this scale and honest
// in both directions.

import type { SupabaseClient } from "@supabase/supabase-js";
import { billingEnabled, PLAN_ARTICLE_LIMITS, type PlanTier } from "@/lib/stripe";
import { getSimulation } from "@/lib/dev/simulation";

export type Quota = {
  /** Null means unmetered. */
  limit: number | null;
  used: number;
  /** Null when unmetered. */
  remaining: number | null;
  /** Why the limit is what it is, for UI copy. */
  reason: "self-host" | "operator" | "plan" | "no-plan";
  plan: PlanTier | null;
};

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? "helloaltorank@gmail.com")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

function monthStart(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/**
 * Compute the quota for an agency. Pass the caller's Supabase client so RLS
 * scopes the counts to what that caller can see anyway.
 */
export async function getQuota(
  supabase: SupabaseClient,
  agencyId: string,
  userEmail?: string | null,
): Promise<Quota> {
  // Resolve the caller when not handed one. On the cookie client this is the
  // signed-in user (operator bypass works); on the cron's service client it is
  // null, which is right - a cron is nobody's operator.
  if (userEmail === undefined) {
    const { data } = await supabase.auth.getUser();
    userEmail = data.user?.email ?? null;
  }
  const { data: workspaceRows } = await supabase
    .from("workspaces")
    .select("id")
    .eq("agency_id", agencyId);
  const workspaceIds = (workspaceRows ?? []).map((w) => w.id);

  let used = 0;
  if (workspaceIds.length) {
    const { count } = await supabase
      .from("articles")
      .select("id", { count: "exact", head: true })
      .in("workspace_id", workspaceIds)
      .gte("created_at", monthStart());
    used = count ?? 0;
  }

  if (userEmail && ADMIN_EMAILS.includes(userEmail.toLowerCase())) {
    return { limit: null, used, remaining: null, reason: "operator", plan: null };
  }

  if (!billingEnabled) {
    return { limit: null, used, remaining: null, reason: "self-host", plan: null };
  }

  const { data: agency } = await supabase
    .from("agencies")
    .select("plan, plan_status")
    .eq("id", agencyId)
    .single();

  let active = agency?.plan_status === "active";
  let plan = (agency?.plan ?? null) as PlanTier | null;

  // Dev-only: the DevToolbar's simulated plan drives the quota too, so "what
  // does a Managed customer at 97/100 see" is testable without a live
  // subscription. Inert in production (getSimulation returns null there).
  const simulation = await getSimulation();
  if (simulation?.plan) {
    plan = simulation.plan;
    active = true;
  }

  if (!active || !plan) {
    return { limit: 0, used, remaining: 0, reason: "no-plan", plan };
  }

  const limit = PLAN_ARTICLE_LIMITS[plan];
  if (limit === null) {
    return { limit: null, used, remaining: null, reason: "plan", plan };
  }

  return { limit, used, remaining: Math.max(0, limit - used), reason: "plan", plan };
}

/** Message for the moment generation is refused. Says what to do, not just no. */
export function quotaExceededMessage(q: Quota): string {
  if (q.reason === "no-plan") {
    return "This account has no active plan. Subscribe on the Billing page to generate articles, or self-host AltoRank free.";
  }
  return `This month's included ${q.limit} articles are used. The next article is billed as overage, or upgrade on the Billing page.`;
}

/**
 * Overage per additional article, in cents, exactly as the pricing page
 * states it: EUR 0.60 on Managed, EUR 0.45 on Agency. Restated from
 * apps/marketing/src/data/pricing.ts - change them together.
 */
export const OVERAGE_CENTS: Record<Exclude<PlanTier, "scale">, number> = {
  starter: 60,
  growth: 45,
};
