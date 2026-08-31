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
    success_url: `${APP_URL}/settings/billing?status=success`,
    cancel_url: `${APP_URL}/settings/billing?status=cancelled`,
  });

  if (!session.url) throw new Error("Failed to create checkout session");
  return session.url;
}

/**
 * Open the Stripe customer billing portal (manage/cancel subscription, invoices,
 * payment method). Owner only. Returns the portal URL.
 */
export async function createBillingPortalSession(): Promise<string> {
  const { agencyId } = await requireAuth(["owner"]);
  const supabase = await createClient();

  const { data: agency } = await supabase
    .from("agencies")
    .select("stripe_customer_id")
    .eq("id", agencyId)
    .single();

  if (!agency?.stripe_customer_id) {
    throw new Error("No billing account yet — subscribe to a plan first");
  }

  const session = await getStripe().billingPortal.sessions.create({
    customer: agency.stripe_customer_id,
    return_url: `${APP_URL}/settings/billing`,
  });

  return session.url;
}
