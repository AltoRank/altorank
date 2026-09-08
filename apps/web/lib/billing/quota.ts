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
//   Cloud, no active plan              FREE_DRAFTS - a week's worth - ONCE.
//                                      This was zero, then one, then seven a
//                                      calendar month refilling forever
//                                      (2026-09-06, #119), and is now seven
//                                      for the life of the account
//                                      (2026-09-07, migration 083). A standing
//                                      monthly allowance is a free tier the
//                                      product cannot afford: a signup costs
//                                      about $1.93 in provider calls, and
//                                      seven a month forever is that bill
//                                      every month against no revenue.
//   Operator accounts                  unlimited, so dogfooding does not eat
//                                      a customer-shaped quota.
//
// Two different counts, because the two limits mean different things:
//
//   plan limit    articles *created* this calendar month across the agency's
//                 workspaces, cron and manual alike. Deletes free quota back;
//                 that is acceptable at this scale and honest in both
//                 directions, because the counter refills anyway.
//   free tier     `agencies.free_drafts_used`, a durable counter that a delete
//                 cannot walk backwards, floored by the live all-time article
//                 count so a generation path that forgets to increment it
//                 cannot hand out an unrecorded free draft. Against a
//                 one-time allowance, delete-to-refill would be unbounded.

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
  /**
   * How many articles this calendar month, kept beside `used` because on the
   * free tier `used` is the lifetime count and this is not. The only reader
   * is the copy that has to explain a mid-month lock (see
   * `spentUnderOldMonthlyRule`): an account that took seven in August and
   * seven in September has one free draft left under the rule it signed up
   * under and none under this one, and being told which is the difference
   * between a changed price and a broken button.
   */
  monthUsed?: number;
};

/**
 * True when this account still had free drafts under the old monthly rule and
 * has none under the one-time one.
 *
 * The lock is correct - the allowance is one-time now - but arriving at it
 * mid-month, with the counter visibly not at seven, needs a sentence saying
 * the rule changed. Everything that refuses a free-tier action asks this.
 */
export function spentUnderOldMonthlyRule(q: Quota): boolean {
  if (q.reason !== "no-plan" || q.limit === null) return false;
  if (q.monthUsed === undefined) return false;
  return q.monthUsed < q.limit && q.used >= q.limit;
}

function monthStart(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/**
 * The 1st of next month, UTC: the moment a *plan's* included volume starts
 * again.
 *
 * Free drafts do not reset any more (migration 083), so nothing on the
 * `no-plan` path may quote this date. It is the paid tier's reset only.
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
  const { data: workspaceRows, error: workspaceError } = await counting
    .from("workspaces")
    .select("id")
    .eq("agency_id", agencyId);
  // A failed read used to become an empty list, which became `used = 0`, which
  // the usage meter printed as "0 used" - a measurement, from nothing. The
  // house rule is that an unknown is never a zero, and a quota is the one
  // number the app makes decisions on.
  if (workspaceError) throw new Error(`quota: could not read this account's sites (${workspaceError.message})`);
  const workspaceIds = (workspaceRows ?? []).map((w) => w.id);

  let used = 0;
  let everUsed = 0;
  if (workspaceIds.length) {
    const [
      { count: thisMonth, error: usedError },
      { count: ever, error: everError },
    ] = await Promise.all([
      counting
        .from("articles")
        .select("id", { count: "exact", head: true })
        .in("workspace_id", workspaceIds)
        .gte("created_at", monthStart()),
      // Every article the agency has ever had. Only the free tier reads this,
      // and only as a floor under the stored counter below.
      counting
        .from("articles")
        .select("id", { count: "exact", head: true })
        .in("workspace_id", workspaceIds),
    ]);
    // Same house rule as the read above: an unknown is never a zero, and on
    // the free tier a silent zero here would hand out an eighth free draft.
    if (usedError) throw new Error(`quota: could not count this month's articles (${usedError.message})`);
    if (everError) throw new Error(`quota: could not count this account's articles (${everError.message})`);
    used = thisMonth ?? 0;
    everUsed = ever ?? 0;
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

  // The read that decides whether this account is entitled to anything. Its
  // error was dropped, so a transient failure demoted a paying customer to the
  // free tier for the length of the request: `planEntitled({})` is false, and
  // that propagates to the sidebar usage bar, the "rank tracking runs for
  // accounts on a plan" banner on Keywords, the New-article gate and the
  // calendar's write gate. A refusal derived from a failed read is not a
  // refusal, and this one asks the customer to buy what they already have.
  //
  // `maybeSingle`, not `single`: an agency row that genuinely does not exist
  // is a different fact from a read that failed, and it keeps the fallback the
  // rest of this function was written against.
  const { data: agency, error: agencyError } = await counting
    .from("agencies")
    .select("plan, plan_status, payment_failed_at, free_drafts_used")
    .eq("id", agencyId)
    .maybeSingle();
  if (agencyError) throw new Error(`quota: could not read this account's plan (${agencyError.message})`);

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
    // A week of drafts before the paywall - FREE_DRAFTS, once. The first
    // outside signup (2026-09-02)
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
    //
    // The free tier's counter is the stored one, floored by the all-time
    // article count. `free_drafts_used` is what a delete cannot walk back; the
    // count is what catches a writer that forgot to increment it. Reading
    // both and taking the larger means neither a delete nor a missed
    // increment can hand out an eighth free draft. `monthUsed` rides along so
    // the copy can explain a lock that lands mid-month (migration 083).
    const freeUsed = Math.max((agency?.free_drafts_used as number | null) ?? 0, everUsed);
    return {
      limit: FREE_DRAFTS,
      used: freeUsed,
      remaining: Math.max(0, FREE_DRAFTS - freeUsed),
      reason: "no-plan",
      plan: null,
      dunning,
      monthUsed: used,
    };
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
 *
 * One-time since 2026-09-07 (migration 083): these seven are the whole free
 * tier, not seven a month.
 */
export const FREE_DRAFTS = 7;

/**
 * "All 7 free drafts are used." - counted off the limit, never typed.
 *
 * FREE_DRAFTS went 1 -> 7 on 2026-09-06 and nine user-facing strings still
 * said "the free draft"; one of them rendered "the free tier includes 7
 * draft". Every one of them now goes through here or through `plural`, so the
 * next change to the constant changes the copy with it.
 *
 * It said "This month's 7 free drafts are used" until 2026-09-07, which was
 * true while the count refilled on the 1st. It no longer does, and a sentence
 * that says "this month's" is a promise that next month is different.
 */
export function freeAllowanceUsedMessage(limit: number = FREE_DRAFTS): string {
  return `All ${freeAllowanceUsedClause(limit)}.`;
}

/**
 * The same fact as a clause, for a sentence that has already started:
 * "Inactive: all 7 free drafts are used."
 */
export function freeAllowanceUsedClause(limit: number = FREE_DRAFTS): string {
  return `${plural(limit, "free draft")} ${limit === 1 ? "is" : "are"} used`;
}

/**
 * The sentence that explains a lock arriving mid-month.
 *
 * Only for an account that still had drafts under the old monthly rule. It is
 * the difference between "the price changed and here is what changed" and a
 * button that stopped working for no stated reason. Empty for everyone else,
 * so callers can append it unconditionally.
 */
export function freeAllowanceRuleChangeNote(q: Quota): string {
  if (!spentUnderOldMonthlyRule(q)) return "";
  return ` The free drafts used to refill on the 1st; since 2026-09-07 they are ${plural(q.limit ?? FREE_DRAFTS, "one-time draft")} for the account, and yours have been written.`;
}

/** Message for the moment generation is refused. Says what to do, not just no. */
export function quotaExceededMessage(q: Quota, now: Date = new Date()): string {
  if (q.reason === "no-plan") {
    // No reset date on this branch any more. Waiting used to be a real third
    // option beside paying and self-hosting; it is not, and naming a date the
    // counter will not honour is the worst of the three things this sentence
    // could do.
    return `${freeAllowanceUsedMessage(q.limit ?? FREE_DRAFTS)} Choose a plan on the Billing page to keep going, or self-host AltoRank free.${freeAllowanceRuleChangeNote(q)}`;
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

/**
 * Refusing to arm a schedule that would never run. Same shape as
 * CHOOSE_PLAN_MESSAGE: say what is missing and where to fix it, never just no.
 *
 * cron/refresh gates on entitledToScheduledWork, so a switch flipped on
 * without a plan is a promise the product does not keep - the settings page
 * would read "Rewrites on Tue and Thu" and nothing would ever be written.
 */
export const SCHEDULED_REWRITES_NEED_PLAN =
  "Scheduled rewrites need a plan: each one is a model call on a schedule, so they run for paid accounts only. Nothing has been charged yet; choose a plan on the Billing page and this switch works. Candidates and briefs on the Improvements page stay available either way.";
