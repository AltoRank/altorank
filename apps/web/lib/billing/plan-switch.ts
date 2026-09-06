// ---------------------------------------------------------------------------
// Plan switch: change the subscription, or start one?
// ---------------------------------------------------------------------------
//
// "Switch to Agency" on a paying account opened a fresh Checkout, and Stripe
// did what it was asked: a second subscription, billed beside the first
// (2026-09-06). The decision of which door to open lives here so
// the server action can be tested without Stripe.

import { isPastDueStatus } from "@/lib/billing/dunning";

/**
 * Whether the subscription on the row is one to change, rather than replace.
 *
 * Live, trialing and past due all mean Stripe holds a subscription that will
 * bill again; the switch has to happen on that one. Canceled and inactive
 * rows keep a stale id, and a new Checkout is the right door for them.
 */
export function subscriptionSwitchable(agency: {
  stripe_subscription_id?: string | null;
  plan_status?: string | null;
}): boolean {
  if (!agency.stripe_subscription_id) return false;
  const s = agency.plan_status;
  return s === "active" || s === "trialing" || isPastDueStatus(s);
}
