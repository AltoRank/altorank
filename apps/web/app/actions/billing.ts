"use server";

import { requireAuth } from "@/lib/auth/require-auth";
import { createClient } from "@/lib/supabase/server";
import { getStripe, PLAN_PRICE_IDS } from "@/lib/stripe";
import type { SelfServePlan, BillingInterval } from "@/lib/stripe";
import { subscriptionSwitchable } from "@/lib/billing/plan-switch";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3100";

/**
 * Start a Stripe Checkout session for a self-serve plan, or - when the
 * account already has a subscription - move that subscription to the new
 * price. Owner only. Returns the URL for the client to go to next: Stripe's
 * hosted checkout for a first purchase, the Billing page for a switch.
 *
 * The switch used to open a second Checkout in `mode: "subscription"`.
 * Stripe obliged with a second subscription; `customer.subscription.created`
 * then overwrote `stripe_subscription_id`, and the first subscription kept
 * billing with nothing pointing at it (2026-09-06). A plan change on
 * an existing subscription is `subscriptions.update` on its item, prorated,
 * and the webhook's `customer.subscription.updated` writes the tier the new
 * price sells.
 */
export async function createCheckoutSession(
  plan: SelfServePlan,
  interval: BillingInterval = "month",
  /**
   * Where to land after paying. Someone who hit the workspace limit while
   * choosing Search Console properties should come back to that screen with
   * their selection intact, not to a billing page (2026-09-02). Same-origin
   * paths only: this value reaches Stripe and comes back as a redirect.
   */
  returnTo?: string,
): Promise<string> {
  const { agencyId } = await requireAuth(["owner"]);
  const supabase = await createClient();

  const priceId = PLAN_PRICE_IDS[plan][interval];
  if (!priceId) throw new Error(`No Stripe price configured for the ${plan} plan (${interval})`);

  const { data: agency } = await supabase
    .from("agencies")
    .select("stripe_customer_id, stripe_subscription_id, plan_status")
    .eq("id", agencyId)
    .single();

  if (agency && subscriptionSwitchable(agency)) {
    await switchSubscriptionPrice(agency.stripe_subscription_id as string, priceId, {
      agencyId,
      plan,
      interval,
    });
    // The tier follows the price at once rather than on the webhook's
    // schedule, so the page that reloads next says what was just bought.
    await supabase.from("agencies").update({ plan }).eq("id", agencyId);
    return `${APP_URL}/settings/billing?status=switched`;
  }

  const session = await getStripe().checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    customer: agency?.stripe_customer_id ?? undefined,
    client_reference_id: agencyId,
    // metadata on both the session and the subscription so the webhook can map
    // any subscription event back to the agency regardless of which fires first.
    //
    // `plan` rides along as the webhook's fallback for the tier. The price on
    // the subscription is authoritative and the webhook prefers it; this is
    // what it falls back to when the subscription read fails, so a checkout
    // can never leave the account on the `starter` column default while the
    // customer is paying for Agency (2026-09-06).
    metadata: { agency_id: agencyId, plan, interval },
    subscription_data: { metadata: { agency_id: agencyId, plan, interval } },
    success_url:
      returnTo && /^\/[a-zA-Z0-9/_?=&%-]*$/.test(returnTo)
        ? `${APP_URL}${returnTo}${returnTo.includes("?") ? "&" : "?"}upgraded=1`
        : `${APP_URL}/settings/billing?status=success`,
    cancel_url: `${APP_URL}/settings/billing?status=cancelled`,
  });

  if (!session.url) throw new Error("Failed to create checkout session");
  return session.url;
}

/**
 * Move an existing subscription to `priceId`, on its one item, prorated.
 *
 * `items[].id` is the subscription item being replaced: without it Stripe
 * adds a second item and bills both. Prorations credit the unused part of
 * the old price and charge the new one from today, which is what "switch"
 * means to someone reading the invoice. Metadata is refreshed so the
 * webhook's fallback hint agrees with the price it prefers.
 */
async function switchSubscriptionPrice(
  subscriptionId: string,
  priceId: string,
  meta: { agencyId: string; plan: SelfServePlan; interval: BillingInterval },
): Promise<void> {
  const stripe = getStripe();
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const item = sub.items?.data?.[0];
  if (!item) throw new Error("The current subscription has no plan item to change");
  if (item.price?.id === priceId) return;

  await stripe.subscriptions.update(subscriptionId, {
    items: [{ id: item.id, price: priceId }],
    proration_behavior: "create_prorations",
    metadata: { agency_id: meta.agencyId, plan: meta.plan, interval: meta.interval },
  });
}

/**
 * Open the Stripe customer billing portal (manage/cancel subscription, invoices,
 * payment method). Owner only. Returns the portal URL.
 */
export type PortalFlow = "manage" | "cancel" | "payment_method";

/**
 * `flow` opens the portal on a specific screen instead of its home:
 *
 *   cancel          the cancellation confirmation, one click from our page
 *   payment_method  the card update / removal screen
 *
 * The category we compete in has "there is no cancel button in the app" as
 * its single most repeated one-star review (see altorank-notes,
 * 2026-09-02-what-the-reviews-say.md). A portal link that lands on a home
 * screen with a cancel option three clicks deep is not a cancel button. This
 * is: the button on our page says Cancel, and the next screen is the
 * confirmation. Nothing about the plan, the data or the articles changes when
 * they do it; the subscription ends at period end and the workspace stays
 * readable.
 */
export async function createBillingPortalSession(flow: PortalFlow = "manage"): Promise<string> {
  const { agencyId } = await requireAuth(["owner"]);
  const supabase = await createClient();

  const { data: agency } = await supabase
    .from("agencies")
    .select("stripe_customer_id, stripe_subscription_id")
    .eq("id", agencyId)
    .single();

  if (!agency?.stripe_customer_id) {
    throw new Error("No billing account yet — subscribe to a plan first");
  }

  const returnUrl = `${APP_URL}/settings/billing`;
  const base = { customer: agency.stripe_customer_id, return_url: returnUrl };

  if (flow === "cancel") {
    if (!agency.stripe_subscription_id) {
      throw new Error("There is no active subscription to cancel");
    }
    const session = await getStripe().billingPortal.sessions.create({
      ...base,
      flow_data: {
        type: "subscription_cancel",
        subscription_cancel: { subscription: agency.stripe_subscription_id },
        after_completion: { type: "redirect", redirect: { return_url: `${returnUrl}?status=cancelled` } },
      },
    });
    return session.url;
  }

  if (flow === "payment_method") {
    const session = await getStripe().billingPortal.sessions.create({
      ...base,
      flow_data: { type: "payment_method_update" },
    });
    return session.url;
  }

  const session = await getStripe().billingPortal.sessions.create(base);
  return session.url;
}
