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
//   Cloud, no active plan              FREE_DRAFTS - a week's worth - per
//                                      calendar month, indefinitely. This was
//                                      zero, then one, and became seven on
//                                      2026-09-06 (#119). It is a standing
//                                      free tier, not a trial: nothing expires
//                                      and the count refills on the 1st.
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
import { agencyCountingClient } from "@/lib/billing/agency-client";
import { dunningInfo, planEntitled, type DunningInfo } from "@/lib/billing/dunning";
import { plural } from "@/lib/utils";

export type Quota = {
  /** Null means unmetered. */
  limit: number | null;
  used: number;
  /** Null when unmetered. */
  remaining: number | null;
  /** Why the limit is what it is, for UI copy. */
  reason: "self-host" | "operator" | "plan" | "no-plan";
  plan: PlanTier | null;
  /**
   * Set while a renewal is failing: `grace` keeps the paid tier's `reason:
   * "plan"`, `lapsed` is `reason: "no-plan"` with the card still unpaid.
   * Undefined on the paths that never read the agency row.
   */
  dunning?: DunningInfo | null;
};

function monthStart(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/**
 * The 1st of next month, UTC: the moment `used` starts again.
 *
 * The counter above is the whole reason the allowance refills, so the date
 * lives beside it rather than in the copy that quotes it.
 */
export function nextResetDate(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/**
 * Compute the quota for an agency. Pass the caller's Supabase client; the
 * counts themselves run agency-wide (lib/billing/agency-client.ts), because a
 * member scoped to some of the sites would otherwise be handed the whole
 * account's allowance again for the sites they can see.
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
  // Agency-wide, never the caller's slice of it: see agency-client.ts.
  const counting = agencyCountingClient(supabase);
  const { data: workspaceRows } = await counting
    .from("workspaces")
    .select("id")
    .eq("agency_id", agencyId);
  const workspaceIds = (workspaceRows ?? []).map((w) => w.id);

  let used = 0;
  if (workspaceIds.length) {
    const { count } = await counting
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

  const { data: agency } = await counting
    .from("agencies")
    .select("plan, plan_status, payment_failed_at")
    .eq("id", agencyId)
    .single();

  // `past_due` inside the grace window counts as paid: a card that failed at
  // renewal is Stripe's to retry for a week, and locking approve and publish
  // on day one turned "update your card" into "choose a plan" and a second
  // subscription (lib/billing/dunning.ts).
  let active = planEntitled(agency ?? {});
  let plan = (agency?.plan ?? null) as PlanTier | null;
  const dunning = dunningInfo(agency ?? {});

  // Dev-only: the DevToolbar's simulated plan drives the quota too, so "what
  // does a Managed customer at 97/100 see" is testable without a live
  // subscription. Inert in production (getSimulation returns null there).
  const simulation = await getSimulation();
  if (simulation?.plan) {
    plan = simulation.plan;
    active = true;
  }

  if (!active || !plan) {
    // A week of drafts before the paywall - FREE_DRAFTS, seven since
    // 2026-09-06, and one before that. The first outside signup (2026-09-02)
    // created a workspace, ran an audit and left within seven minutes; the
    // only place a plan was ever mentioned was a quota error behind a button
    // they never pressed. A draft in the review queue, with its fact-check
    // verdict, is the thing worth paying for; the audit alone is not. So the
    // draft is free, and approving or publishing it is where the plan is
    // asked for (see requireActivePlan). Nothing is charged until they choose.
    //
    // `plan: null`, not the column. `agencies.plan` is `not null default
    // 'starter'`, so an account that never bought anything carries "starter"
    // and every reader that trusted this field said so: GET
    // /auth/whoami answered `plan: "starter", reason: "no-plan"` and an agent
    // reading it tells the human they are on Managed. The tier that is not
    // being paid for is not this field's answer - `dunning` carries the tier a
    // lapsed subscription would come back to, and the Billing page reads the
    // row itself for that.
    return { limit: FREE_DRAFTS, used, remaining: Math.max(0, FREE_DRAFTS - used), reason: "no-plan", plan: null, dunning };
  }

  const limit = PLAN_ARTICLE_LIMITS[plan];
  if (limit === null) {
    return { limit: null, used, remaining: null, reason: "plan", plan, dunning };
  }

  return { limit, used, remaining: Math.max(0, limit - used), reason: "plan", plan, dunning };
}

/**
 * Whether an account is entitled to the scheduled paid loop.
 *
 * The free drafts buy a look at the product: a workspace, a first look, a
 * week of articles with their fact checks. They do not buy a standing
 * subscription to DataForSEO. Rank tracking runs nightly and forever, so an
 * account that signed up, took its free drafts - which it cannot approve or
 * publish without a plan - and never came back kept costing money every night
 * for articles that could never ship.
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

/**
 * Drafts an account gets before choosing a plan. Approving them needs one.
 *
 * A week's worth, so a new account sees the calendar working rather than a
 * single article and an empty week behind it. Raised from 1 on 2026-09-06.
 * Onboarding writes the first inline; cron/generate writes the rest at the
 * site's pace, which FREE_TIER_PACE raises to match so they land in that week
 * rather than over seven of them.
 */
export const FREE_DRAFTS = 7;

/**
 * "This month's 7 free drafts are used." - counted off the limit, never typed.
 *
 * FREE_DRAFTS went 1 -> 7 on 2026-09-06 and nine user-facing strings still
 * said "the free draft"; one of them rendered "the free tier includes 7
 * draft". Every one of them now goes through here or through `plural`, so the
 * next change to the constant changes the copy with it.
 */
export function freeAllowanceUsedMessage(limit: number = FREE_DRAFTS): string {
  return `This month's ${freeAllowanceUsedClause(limit)}.`;
}

/**
 * The same fact as a clause, for a sentence that has already started:
 * "Inactive: this month's 7 free drafts are used."
 */
export function freeAllowanceUsedClause(limit: number = FREE_DRAFTS): string {
  return `${plural(limit, "free draft")} ${limit === 1 ? "is" : "are"} used`;
}

/** Message for the moment generation is refused. Says what to do, not just no. */
export function quotaExceededMessage(q: Quota, now: Date = new Date()): string {
  if (q.reason === "no-plan") {
    // The reset is part of the answer: `used` is counted from monthStart(), so
    // waiting is a real third option beside paying and self-hosting - and the
    // date says how long, which "the 1st" alone does not.
    const resets = nextResetDate(now).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
    return `${freeAllowanceUsedMessage(q.limit ?? FREE_DRAFTS)} Choose a plan on the Billing page to keep going, wait for ${resets} when the allowance resets, or self-host AltoRank free.`;
  }
  // Only the scheduled writer ever reads this branch: a manual generation past
  // the included volume does not refuse, it bills the overage
  // (lib/content/generate.ts). So the sentence has to describe what the cron
  // does, which is stop - it said "the next article is billed as overage",
  // which is the one thing a cron will never do ("a cron must never be the
  // thing that spends a customer's money"). The overage is still the way
  // through, and it is named as the deliberate, human action it is.
  const resets = nextResetDate(now).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return `This month's included ${q.limit} articles are used. Scheduled writing stops until ${resets}; upgrade on the Billing page, or write one by hand from the calendar to bill it as overage.`;
}

/**
 * Overage per additional article, in cents, exactly as the pricing page
 * states it: EUR 0.60 on Managed, EUR 0.45 on Agency. Restated from
 * src/data/pricing.ts in AltoRank/altorank-marketing - change them together.
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
