"use server";

import { requireAuth } from "@/lib/auth/require-auth";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getStripe, PLAN_PRICE_IDS, stripeTaxEnabled } from "@/lib/stripe";
import type { SelfServePlan, BillingInterval } from "@/lib/stripe";
import { subscriptionSwitchable } from "@/lib/billing/plan-switch";
import { billingFailure, type BillingRedirect } from "@/lib/billing/failure";

import { appUrl } from "@/lib/app-url";

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
): Promise<BillingRedirect> {
  const { agencyId } = await requireAuth(["owner"]);
  const supabase = await createClient();

  const priceId = PLAN_PRICE_IDS[plan][interval];
  if (!priceId) {
    return {
      ok: false,
      error: `This deployment has no Stripe price configured for the ${plan} plan (${interval}), so it cannot be bought here. Nothing was charged.`,
    };
  }

  const { data: agency } = await supabase
    .from("agencies")
    .select("stripe_customer_id, stripe_subscription_id, plan_status")
    .eq("id", agencyId)
    .single();

  if (agency && subscriptionSwitchable(agency)) {
    try {
      await switchSubscriptionPrice(agency.stripe_subscription_id as string, priceId, {
        agencyId,
        plan,
        interval,
      });
    } catch (err) {
      return billingFailure(err, "The plan could not be switched");
    }
    // The tier follows the price at once rather than on the webhook's
    // schedule, so the page that reloads next says what was just bought.
    //
    // As AltoRank, not as the owner: `plan` is one of the columns migration
    // 072 refuses to a signed-in user (42501), so through the cookie client
    // this was a silent no-op and the page kept saying the old tier until the
    // webhook landed. Stripe has already accepted the switch by this line, so
    // a refusal here is worth a log line, not a failed action.
    const { error } = await createServiceClient().from("agencies").update({ plan }).eq("id", agencyId);
    if (error) console.error(`[billing] switch: plan not written for ${agencyId}: ${error.message}`);
    return { ok: true, url: `${appUrl()}/settings/billing?status=switched` };
  }

  let session;
  try {
    session = await getStripe().checkout.sessions.create({
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
      // VAT, added at checkout rather than folded into the price.
      //
      // Nothing here handled tax before, so exactly EUR 69 / EUR 199 was charged
      // to everyone. Inclusive pricing cannot work for this buyer: a VAT-
      // registered business elsewhere in the EU is reverse-charged (it
      // self-accounts and we collect nothing), while a consumer is charged at
      // their own country's rate, 17% to 27%. One inclusive price would therefore
      // pay us a different amount depending on who bought it and from where.
      //
      // `automatic_tax` makes Stripe decide the rate from the customer's
      // location; `tax_id_collection` captures the VAT number that triggers the
      // reverse charge; `customer_update.address` lets Stripe keep the address it
      // needs to do either again on renewal, and is only accepted when the
      // session already has a customer. The prices carry `tax_behavior:
      // 'exclusive'` on the Price object in the Stripe dashboard - that is not
      // something this call can set.
      // Only when the account is set up for it: with Stripe Tax not activated,
      // `automatic_tax` makes this call throw and nobody can pay. See
      // stripeTaxEnabled in lib/stripe.ts for the switch and its preconditions.
      ...(stripeTaxEnabled
        ? {
            automatic_tax: { enabled: true },
            tax_id_collection: { enabled: true },
            ...(agency?.stripe_customer_id
              ? { customer_update: { address: "auto" as const, name: "auto" as const } }
              : {}),
          }
        : {}),
      success_url:
        returnTo && /^\/[a-zA-Z0-9/_?=&%-]*$/.test(returnTo)
          ? `${appUrl()}${returnTo}${returnTo.includes("?") ? "&" : "?"}upgraded=1`
          : `${appUrl()}/settings/billing?status=success`,
      cancel_url: `${appUrl()}/settings/billing?status=cancelled`,
    });
  } catch (err) {
    return billingFailure(err, "Checkout could not be opened");
  }

  if (!session.url) {
    return { ok: false, error: "Stripe did not return a checkout link. Nothing was charged; try again." };
  }
  return { ok: true, url: session.url };
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
export async function createBillingPortalSession(flow: PortalFlow = "manage"): Promise<BillingRedirect> {
  const { agencyId } = await requireAuth(["owner"]);
  const supabase = await createClient();

  const { data: agency } = await supabase
    .from("agencies")
    .select("stripe_customer_id, stripe_subscription_id")
    .eq("id", agencyId)
    .single();

  if (!agency?.stripe_customer_id) {
    return { ok: false, error: "There is no billing account yet — choose a plan first." };
  }

  const returnUrl = `${appUrl()}/settings/billing`;
  const base = { customer: agency.stripe_customer_id, return_url: returnUrl };

  try {
    if (flow === "cancel") {
      if (!agency.stripe_subscription_id) {
        return { ok: false, error: "There is no active subscription to cancel." };
      }
      const session = await getStripe().billingPortal.sessions.create({
        ...base,
        flow_data: {
          type: "subscription_cancel",
          subscription_cancel: { subscription: agency.stripe_subscription_id },
          after_completion: { type: "redirect", redirect: { return_url: `${returnUrl}?status=cancelled` } },
        },
      });
      return { ok: true, url: session.url };
    }

    if (flow === "payment_method") {
      const session = await getStripe().billingPortal.sessions.create({
        ...base,
        flow_data: { type: "payment_method_update" },
      });
      return { ok: true, url: session.url };
    }

    const session = await getStripe().billingPortal.sessions.create(base);
    return { ok: true, url: session.url };
  } catch (err) {
    return billingFailure(err, "The billing portal could not be opened");
  }
}
