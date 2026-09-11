// ---------------------------------------------------------------------------
// The seven-day card trial: who can start one, and what to say about it
// ---------------------------------------------------------------------------
//
// A hosted plan starts with TRIAL_DAYS of trial. The card is taken at
// checkout and charged when the trial ends unless the customer cancels first.
// The offer is made after onboarding: the account's first drafts are written
// against the free allowance and read before any card is entered, so what the
// trial unlocks is approve, publish and everything after the seventh draft.
//
// One trial per account. Stripe does not enforce that on its own (a customer
// can open a second trialing subscription), so eligibility is decided here
// from `accounts.trial_ends_at`, which the webhook stamps from the
// subscription's `trial_end` and which nothing ever clears.

import { TRIAL_DAYS } from "@/lib/stripe";

export type TrialRow = {
  plan_status?: string | null;
  stripe_subscription_id?: string | null;
  trial_ends_at?: string | null;
};

/**
 * Whether checkout should add trial days for this account: never trialed,
 * and not already holding a subscription. An account that had a trial and
 * cancelled it pays from day one the second time.
 */
export function trialEligible(account: TrialRow | null | undefined): boolean {
  if (!account) return true;
  if (account.trial_ends_at) return false;
  if (account.stripe_subscription_id) return false;
  return account.plan_status !== "active" && account.plan_status !== "trialing";
}

export type TrialInfo = {
  /** ISO timestamp the trial ends, always set. */
  endsAt: string;
  /** Whole days left, never negative. 0 on the last day. */
  daysLeft: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The running trial's facts, or null when the account is not trialing. */
export function trialInfo(account: TrialRow | null | undefined, now: Date = new Date()): TrialInfo | null {
  if (!account || account.plan_status !== "trialing" || !account.trial_ends_at) return null;
  const ends = new Date(account.trial_ends_at).getTime();
  if (Number.isNaN(ends)) return null;
  return {
    endsAt: account.trial_ends_at,
    daysLeft: Math.max(0, Math.ceil((ends - now.getTime()) / DAY_MS)),
  };
}

/** "Trial ends in 3 days" / "Trial ends today". */
export function trialEndsLabel(info: TrialInfo): string {
  if (info.daysLeft <= 0) return "Trial ends today";
  if (info.daysLeft === 1) return "Trial ends tomorrow";
  return `Trial ends in ${info.daysLeft} days`;
}

export function formatTrialDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

/** The one sentence the product uses for the offer, everywhere it is made. */
export const TRIAL_OFFER = `${TRIAL_DAYS} days free with a card, then the plan price. Cancel from Billing before it ends and nothing is charged.`;

/**
 * Whether this account must start its trial before the dashboard opens.
 *
 * The order the product now promises: onboarding writes the first draft
 * against the free allowance, the person reads it and the month planned
 * behind it on the run screen, and the card is asked there - not from a
 * banner found later. The dashboard is what the trial opens.
 *
 * Three accounts are never gated, and each for its own reason:
 *
 *   self-host   no Stripe key, so there is no trial to start and nothing to
 *               charge. Gating here would lock an operator out of the install
 *               they are running themselves.
 *   operator    our own accounts, which have no plan by design.
 *   plan        already paying, or already trialing.
 *
 * `TRIAL_GATE_DISABLED` turns it off without a deploy. A gate on the way into
 * the product is the one change where being wrong locks out every account at
 * once, so it ships with its own switch.
 */
export function trialGateApplies(quota: { reason?: string; trialEligible?: boolean } | null | undefined): boolean {
  if (process.env.TRIAL_GATE_DISABLED === "1") return false;
  if (!quota) return false;
  if (quota.reason !== "no-plan") return false;
  return Boolean(quota.trialEligible);
}
