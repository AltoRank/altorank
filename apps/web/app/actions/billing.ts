"use server";

import { requireAuth } from "@/lib/auth/require-auth";
import { createClient } from "@/lib/supabase/server";
import { getStripe, PLAN_PRICE_IDS } from "@/lib/stripe";
import type { SelfServePlan, BillingInterval } from "@/lib/stripe";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3100";

/**
 * Start a Stripe Checkout session for a self-serve plan. Owner only.
 * Returns the hosted checkout URL for the client to redirect to.
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
    .select("stripe_customer_id")
    .eq("id", agencyId)
    .single();

  const session = await getStripe().checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    customer: agency?.stripe_customer_id ?? undefined,
    client_reference_id: agencyId,
    // metadata on both the session and the subscription so the webhook can map
    // any subscription event back to the agency regardless of which fires first.
    metadata: { agency_id: agencyId },
    subscription_data: { metadata: { agency_id: agencyId } },
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
