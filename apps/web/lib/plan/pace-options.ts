// ---------------------------------------------------------------------------
// The paces a person can pick, and which ones their plan pays for
// ---------------------------------------------------------------------------
//
// The slider on the workspace settings page offers 0-25 and says nothing about
// whether the account can afford the number. This is the short list the
// calendar control shows instead: the paces people actually mean ("a couple a
// week", "one a day", "two a day"), each with its monthly consequence and, when
// the account's plan does not include that many, the plan that would - as a
// fact with a link, not a greyed-out mystery.
//
// The allowance comes from lib/billing/quota.ts so the rule is the same one
// that stops the cron. Self-host and operator accounts are unmetered and see
// every option as available.

import { FREE_TIER_PACE, MAX_PACE, monthlyFromPace } from "@/lib/content/pace";
import type { Quota } from "@/lib/billing/quota";
import { PLAN_ARTICLE_LIMITS, PLAN_LABELS, type PlanTier } from "@/lib/stripe";

/** Articles a week. 14 and 21 are two and three a day. */
export const PACE_OPTIONS = [1, 2, 3, 5, 7, 14, 21] as const;

export interface PaceOption {
  pace: number;
  /** "3 a week", "one a day", "two a day". */
  label: string;
  /**
   * The consequence of picking this pace: "about 13 articles a month", or,
   * where the free allowance would run out first, what it actually delivers.
   */
  meaning: string;
  monthly: number;
  /** Whether this account may run at this pace today. */
  allowed: boolean;
  /** When not allowed: the cheapest tier that includes this many a month. */
  needsPlan: PlanTier | null;
  /** Display name of that tier, for "Needs the Managed plan". */
  needsPlanLabel: string | null;
}

export function describePace(pace: number): string {
  if (pace === 7) return "one a day";
  if (pace === 14) return "two a day";
  if (pace === 21) return "three a day";
  if (pace === 1) return "1 a week";
  return `${pace} a week`;
}

/** The cheapest tier whose included volume covers `monthly`; null when none is needed. */
export function planNeededFor(monthly: number): PlanTier {
  for (const tier of ["starter", "growth"] as const) {
    const limit = PLAN_ARTICLE_LIMITS[tier];
    if (limit === null || monthly <= limit) return tier;
  }
  return "scale";
}

/**
 * Is `pace` within what the account pays for?
 *
 * no-plan: the free tier's pace (FREE_TIER_PACE, 7 a week since 2026-09-06)
 * and nothing above it. The quota stops the cron at FREE_DRAFTS a month
 * whatever the pace said, so a higher number here would be a setting with no
 * effect. This comment described a 1-a-week free tier for four days after it
 * stopped being one: the function returns true for 1, 2, 3, 5 and 7.
 * plan: the tier's included monthly volume must cover the pace's monthly figure.
 * unmetered (self-host, operator): anything the column allows.
 */
export function paceAllowed(pace: number, quota: Pick<Quota, "limit" | "reason">): boolean {
  if (pace < 0 || pace > MAX_PACE) return false;
  if (quota.reason === "no-plan") return pace <= FREE_TIER_PACE;
  if (quota.limit === null) return true;
  return monthlyFromPace(pace) <= quota.limit;
}

/**
 * What picking this pace actually gets you, in a phrase.
 *
 * `about ${monthly} articles a month` is arithmetic on the pace and nothing
 * else, which made four of the five paces a free account may select quote a
 * figure the quota then refuses: at 7 a week the row read "about 30 articles a
 * month" while FREE_DRAFTS is 7. The pace is still the honest control - it
 * decides how fast the allowance is spent, which is why 7 a week is offered at
 * all - so where the monthly figure outruns the allowance the phrase states
 * the allowance and how long it lasts instead of a number that cannot arrive.
 *
 * Only the free tier needs this. A paid tier's options are refused outright
 * above its included volume (`paceAllowed`), so an allowed paid pace always
 * fits inside what the plan bought.
 */
export function paceMeaning(
  pace: number,
  monthly: number,
  quota: Pick<Quota, "limit" | "reason">,
): string {
  const limit = quota.limit;
  if (quota.reason === "no-plan" && limit !== null && pace > 0 && monthly > limit) {
    // Days to spend `limit` drafts at `pace` a week, on a 7-day week.
    const days = Math.round((limit / pace) * 7);
    return `the ${limit} free drafts, in about ${days} ${days === 1 ? "day" : "days"}`;
  }
  return `about ${monthly} articles a month`;
}

export function paceOptions(quota: Pick<Quota, "limit" | "reason">): PaceOption[] {
  return PACE_OPTIONS.map((pace) => {
    const monthly = monthlyFromPace(pace);
    const allowed = paceAllowed(pace, quota);
    const needsPlan = allowed ? null : planNeededFor(monthly);
    return {
      pace,
      label: describePace(pace),
      // A refused option is arguing for a plan, so it keeps the monthly figure
      // that plan would deliver; an allowed one has to be true today.
      meaning: allowed ? paceMeaning(pace, monthly, quota) : `about ${monthly} articles a month`,
      monthly,
      allowed,
      needsPlan,
      needsPlanLabel: needsPlan ? PLAN_LABELS[needsPlan] : null,
    };
  });
}
