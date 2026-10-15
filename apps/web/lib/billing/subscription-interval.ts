import { billingEnabled, getStripe, intervalForSubscription, type BillingInterval } from "@/lib/stripe";

/**
 * The interval of the account's subscription, read from Stripe for the
 * Billing page (lib/billing/plan-interval.ts says why it matters there).
 * Short and forgiving: a slow or failed read shows the page as it was before
 * the interval was known (null), not an error on the page people open when
 * they are about to pay.
 */
export async function readSubscriptionInterval(subscriptionId: string | null | undefined): Promise<BillingInterval | null> {
  if (!billingEnabled || !subscriptionId) return null;
  try {
    const sub = await getStripe().subscriptions.retrieve(subscriptionId, {}, { timeout: 3_000, maxNetworkRetries: 0 });
    return intervalForSubscription(sub);
  } catch {
    return null;
  }
}
