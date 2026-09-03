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
import { isAdminEmail } from "@/lib/auth/operators";
import { inCustomerPreview } from "@/lib/auth/preview";
import { agencyHasOperator } from "@/lib/billing/operator-agency";

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
  // Captured before the lookup below, because an explicitly passed null is
  // the crons' way of saying "there is no session here", and that is a
  // different fact from a session that resolved to nobody.
  const noSession = userEmail === null;

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

  // The operator bypass is the single biggest difference between what we see
  // and what a customer sees - unmetered against a real ceiling - so the
  // customer preview has to lift it, or the preview would show the one screen
  // it exists to check in the one state no customer is ever in.
  //
  // Only the bypass is dropped. Everything below runs against the real agency
  // row, so quota is the account's actual usage, not a fixture.
  if (isAdminEmail(userEmail) && !(await inCustomerPreview())) {
    return { limit: null, used, remaining: null, reason: "operator", plan: null };
  }

  // Same bypass, reached the only way a cron can reach it. Without this our own
  // agency is metered by every scheduled job: one draft a month from
  // cron/generate, and since scheduled work was gated on a plan, no rank
  // tracking at all. See lib/billing/operator-agency.ts.
  if (noSession && (await agencyHasOperator(supabase, agencyId))) {
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
    // One draft before the paywall. The first outside signup (2026-09-02)
    // created a workspace, ran an audit and left within seven minutes; the
    // only place a plan was ever mentioned was a quota error behind a button
    // they never pressed. A draft in the review queue, with its fact-check
    // verdict, is the thing worth paying for; the audit alone is not. So the
    // draft is free, and approving or publishing it is where the plan is
    // asked for (see requireActivePlan). Nothing is charged until they choose.
    return { limit: FREE_DRAFTS, used, remaining: Math.max(0, FREE_DRAFTS - used), reason: "no-plan", plan };
  }

  const limit = PLAN_ARTICLE_LIMITS[plan];
  if (limit === null) {
    return { limit: null, used, remaining: null, reason: "plan", plan };
  }

  return { limit, used, remaining: Math.max(0, limit - used), reason: "plan", plan };
}

/**
 * Whether an account is entitled to the scheduled paid loop.
 *
 * The free draft buys a look at the product: a workspace, a first look, one
 * article with its fact check. It does not buy a standing subscription to
 * DataForSEO. Rank tracking runs nightly and forever, so an account that
 * signed up, took its free draft - which it cannot approve or publish without
 * a plan - and never came back kept costing money every night for an article
 * that could never ship.
 *
 * Cheap per account and unbounded in aggregate: a keyword is under two cents a
 * month, and nothing ever stops.
 *
 * `no-plan` is the only refusal. `self-host` must always run - that install
 * pays its own provider bills and gating it would break the open-source
 * promise - and `operator` and `plan` are entitled by definition.
 */
export function entitledToScheduledWork(q: Quota): boolean {
  return q.reason !== "no-plan";
}

/** Drafts an account gets before choosing a plan. Approving them needs one. */
export const FREE_DRAFTS = 1;

/** Message for the moment generation is refused. Says what to do, not just no. */
export function quotaExceededMessage(q: Quota): string {
  if (q.reason === "no-plan") {
    return `The free draft is used. Choose a plan on the Billing page to keep going, or self-host AltoRank free.`;
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

/**
 * True when approving or publishing needs a plan first: cloud billing is on,
 * the caller is not an operator, and the agency has no active subscription.
 * Self-host and operator accounts never see the gate.
 */
export async function needsPlanToShip(
  supabase: SupabaseClient,
  agencyId: string,
  userEmail?: string | null,
): Promise<boolean> {
  const q = await getQuota(supabase, agencyId, userEmail);
  return q.reason === "no-plan";
}

export const CHOOSE_PLAN_MESSAGE =
  "Approving and publishing need a plan. Nothing has been charged yet; choose one on the Billing page and this draft is ready to go.";
