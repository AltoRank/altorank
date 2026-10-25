// ---------------------------------------------------------------------------
// Dunning: what a failed renewal means for the account, and for how long
// ---------------------------------------------------------------------------
//
// A card that fails at renewal used to turn the account into a free one on
// the spot: `past_due` was not `active`, so the quota dropped to the free
// drafts, approve and publish locked, and the Billing page offered "Choose
// Managed" to someone already paying for Managed - which opened a second
// Checkout and a second subscription (2026-09-06).
//
// Stripe retries the card for days. Until it gives up, the honest state is
// "paid plan, payment failed, fix the card": the gates stay open for a grace
// window counted from the failed invoice, and the app says so everywhere.
// After the window the account is what it would have been anyway - free tier
// until the card is updated - but it got there by being told, not by a lock
// that appeared overnight.

/** Days the paid tier stays open after the first failed renewal invoice. */
export const GRACE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export type DunningState = "none" | "grace" | "lapsed";

/** Statuses Stripe uses for "there is a subscription and it is not being paid". */
export function isPastDueStatus(status: string | null | undefined): boolean {
  return status === "past_due" || status === "unpaid";
}

/** When the grace window ends, or null when no failure is recorded. */
export function graceEndsAt(paymentFailedAt: string | null | undefined): Date | null {
  if (!paymentFailedAt) return null;
  const t = new Date(paymentFailedAt).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(t + GRACE_DAYS * DAY_MS);
}

/** The account columns entitlement reads. */
export type EntitlementRow = {
  plan_status?: string | null;
  payment_failed_at?: string | null;
  trial_ends_at?: string | null;
  billing_provider?: string | null;
};

/**
 * How long after `trial_ends_at` a `trialing` row stays entitled.
 *
 * Stripe moves the subscription off `trialing` at the trial's end and tells
 * us by webhook; this is the slack for that event arriving late or being
 * retried. Past it, a row still reading `trialing` is a webhook we missed,
 * not a trial: it was entitled forever, drafting and publishing on a charge
 * nobody had made (assessment 2026-10-25).
 */
export const TRIAL_END_MARGIN_MS = DAY_MS;

/**
 * How long after the trial's end a failed charge is still its FIRST charge.
 *
 * The conversion invoice is created at `trial_end`, and `payment_failed_at`
 * is stamped from that invoice (or from the subscription going past due, at
 * the same moment). A renewal is a whole billing period later, so a week is
 * room for a late event without reaching any renewal.
 */
const FIRST_CHARGE_WINDOW_MS = 7 * DAY_MS;

/**
 * Whether the failing charge is the one that ends the trial: the account has
 * never paid us. Pure.
 *
 * Nothing records a paid invoice, so this reads it off the row: a failure on
 * or within FIRST_CHARGE_WINDOW_MS of `trial_ends_at` is the conversion. The
 * grace window exists for a paying customer whose card expired; given to an
 * account that never paid, it was a week of drafting funded by us
 * (assessment 2026-10-25). Same accepted edge as trialCancelledBeforeCharge
 * (lib/billing/trial-hold.ts): a comp trial granted later from the Stripe
 * dashboard moves `trial_ends_at`, and a renewal that fails right after it
 * reads as a first charge.
 */
export function firstChargeFailed(account: EntitlementRow): boolean {
  if (!isPastDueStatus(account.plan_status)) return false;
  if (!account.trial_ends_at || !account.payment_failed_at) return false;
  const ends = Date.parse(account.trial_ends_at);
  const failed = Date.parse(account.payment_failed_at);
  if (Number.isNaN(ends) || Number.isNaN(failed)) return false;
  return failed < ends + FIRST_CHARGE_WINDOW_MS;
}

/**
 * The account's dunning state.
 *
 *   none     the plan is paid for, or there is no plan at all
 *   grace    a renewal failed within the last GRACE_DAYS; the paid tier stays on
 *   lapsed   the window is over and the card still has not been updated, or
 *            the charge that failed was the trial's first (no grace: the
 *            account has never paid)
 *
 * A `past_due` row with no failure timestamp is `lapsed`: the timestamp is
 * written by the webhook on `invoice.payment_failed` and on the subscription
 * going past due, so its absence means the failure predates this code, and
 * an open-ended grace would be a plan nobody is paying for.
 */
export function dunningState(account: EntitlementRow, now: Date = new Date()): DunningState {
  if (!isPastDueStatus(account.plan_status)) return "none";
  if (firstChargeFailed(account)) return "lapsed";
  const ends = graceEndsAt(account.payment_failed_at);
  if (ends && now.getTime() < ends.getTime()) return "grace";
  return "lapsed";
}

/**
 * Whether a `trialing` row is still inside its trial. A Stripe trial past
 * `trial_ends_at` plus TRIAL_END_MARGIN_MS is a missed webhook and is not
 * entitled. A row with no end date has nothing to bound it by and stays on.
 *
 * Shopify is left alone: its trial ends with no event at all, the row moves
 * to `active` only when the daily sync or a visit to the app runs
 * (lib/shopify/billing.ts), and Shopify bills the store itself, so a late
 * sync costs a paying store nothing it has not paid for.
 */
export function trialStillRunning(account: EntitlementRow, now: Date = new Date()): boolean {
  if (account.plan_status !== "trialing") return false;
  if (account.billing_provider === "shopify") return true;
  if (!account.trial_ends_at) return true;
  const ends = Date.parse(account.trial_ends_at);
  if (Number.isNaN(ends)) return true;
  return now.getTime() < ends + TRIAL_END_MARGIN_MS;
}

/**
 * Whether the tier on the row is currently entitled: paid, trialing inside
 * the trial, or past due on a renewal and inside the grace window. The single
 * answer the quota reads.
 */
export function planEntitled(account: EntitlementRow, now: Date = new Date()): boolean {
  if (account.plan_status === "active") return true;
  // A trial is a paid plan whose first charge is on day eight: Stripe holds
  // the card, and `trialing` is what it reports until then. Treating it as
  // no-plan (the rule until 2026-09-09) would have locked approve and publish
  // for the seven days the trial exists to open. Bounded by its end date, so
  // a webhook that never arrives does not keep it open for good.
  if (account.plan_status === "trialing") return trialStillRunning(account, now);
  return dunningState(account, now) === "grace";
}

export type DunningInfo = {
  state: Exclude<DunningState, "none">;
  /** ISO timestamp the grace window ends, or null when none was recorded or none was given. */
  graceEndsAt: string | null;
  /** Set when the failed charge was the trial's first: there was never a grace window. */
  firstCharge?: true;
};

/** The dunning facts a page needs, or null when the account is not past due. */
export function dunningInfo(account: EntitlementRow, now: Date = new Date()): DunningInfo | null {
  const state = dunningState(account, now);
  if (state === "none") return null;
  if (firstChargeFailed(account)) return { state, graceEndsAt: null, firstCharge: true };
  return { state, graceEndsAt: graceEndsAt(account.payment_failed_at)?.toISOString() ?? null };
}

export function formatGraceDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}
