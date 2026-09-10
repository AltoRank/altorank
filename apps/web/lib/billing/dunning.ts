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

/**
 * The account's dunning state.
 *
 *   none     the plan is paid for, or there is no plan at all
 *   grace    a renewal failed within the last GRACE_DAYS; the paid tier stays on
 *   lapsed   the window is over and the card still has not been updated
 *
 * A `past_due` row with no failure timestamp is `lapsed`: the timestamp is
 * written by the webhook on `invoice.payment_failed` and on the subscription
 * going past due, so its absence means the failure predates this code, and
 * an open-ended grace would be a plan nobody is paying for.
 */
export function dunningState(
  account: { plan_status?: string | null; payment_failed_at?: string | null },
  now: Date = new Date(),
): DunningState {
  if (!isPastDueStatus(account.plan_status)) return "none";
  const ends = graceEndsAt(account.payment_failed_at);
  if (ends && now.getTime() < ends.getTime()) return "grace";
  return "lapsed";
}

/**
 * Whether the tier on the row is currently entitled: paid, or past due and
 * inside the grace window. The single answer the quota reads.
 */
export function planEntitled(
  account: { plan_status?: string | null; payment_failed_at?: string | null },
  now: Date = new Date(),
): boolean {
  if (account.plan_status === "active") return true;
  return dunningState(account, now) === "grace";
}

export type DunningInfo = {
  state: Exclude<DunningState, "none">;
  /** ISO timestamp the grace window ends, or null when none was recorded. */
  graceEndsAt: string | null;
};

/** The dunning facts a page needs, or null when the account is not past due. */
export function dunningInfo(
  account: { plan_status?: string | null; payment_failed_at?: string | null },
  now: Date = new Date(),
): DunningInfo | null {
  const state = dunningState(account, now);
  if (state === "none") return null;
  return { state, graceEndsAt: graceEndsAt(account.payment_failed_at)?.toISOString() ?? null };
}

export function formatGraceDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}
