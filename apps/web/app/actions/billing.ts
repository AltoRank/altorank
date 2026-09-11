"use server";

import { requireAuth } from "@/lib/auth/require-auth";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getStripe, PLAN_PRICE_IDS, stripeTaxEnabled, TRIAL_DAYS } from "@/lib/stripe";
import { trialEligible } from "@/lib/billing/trial";
import type { SelfServePlan, BillingInterval } from "@/lib/stripe";
import { subscriptionSwitchable } from "@/lib/billing/plan-switch";
import { billingFailure, type BillingRedirect } from "@/lib/billing/failure";
import { priceIsTaxExclusive } from "@/lib/billing/tax-guard";

import { createPendingCheckout } from "@/lib/billing/checkout-attempt";
import { checkoutDestination } from "@/lib/billing/checkout-return";
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
  const { accountId } = await requireAuth(["owner"]);
  const supabase = await createClient();

  const priceId = PLAN_PRICE_IDS[plan][interval];
  if (!priceId) {
    return {
      ok: false,
      error: `This deployment has no Stripe price configured for the ${plan} plan (${interval}), so it cannot be bought here. Nothing was charged.`,
    };
  }

  const { data: account } = await supabase
    .from("accounts")
    .select("stripe_customer_id, stripe_subscription_id, plan_status, trial_ends_at")
    .eq("id", accountId)
    .single();

  if (account && subscriptionSwitchable(account)) {
    try {
      await switchSubscriptionPrice(account.stripe_subscription_id as string, priceId, {
        accountId,
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
    const { error } = await createServiceClient().from("accounts").update({ plan }).eq("id", accountId);
    if (error) console.error(`[billing] switch: plan not written for ${accountId}: ${error.message}`);
    return { ok: true, url: `${appUrl()}/settings/billing?status=switched` };
  }

  // Only when the account is set up for it, and only on a price that is
  // tax-exclusive: see lib/billing/tax-guard.ts for what an inclusive price
  // would do to the amount that arrives.
  const addTax = stripeTaxEnabled && (await priceIsTaxExclusive(getStripe(), priceId));

  // The seven-day trial, on a first subscription only. `payment_method_collection:
  // "always"` is the whole point: Stripe's default for a trial is
  // `if_required`, which skips the card and then pauses the subscription on
  // day eight, and `missing_payment_method: "cancel"` is the matching belt for
  // a card that somehow was not saved. An account that already trialed pays
  // from today (lib/billing/trial.ts).
  const withTrial = trialEligible(account);

  let session;
  try {
    session = await createPendingCheckout(accountId, {
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      customer: account?.stripe_customer_id ?? undefined,
      client_reference_id: accountId,
      ...(withTrial ? { payment_method_collection: "always" as const } : {}),
      // metadata on both the session and the subscription so the webhook can map
      // any subscription event back to the account regardless of which fires first.
      //
      // `plan` rides along as the webhook's fallback for the tier. The price on
      // the subscription is authoritative and the webhook prefers it; this is
      // what it falls back to when the subscription read fails, so a checkout
      // can never leave the account on the `starter` column default while the
      // customer is paying for Agency (2026-09-06).
      metadata: { account_id: accountId, plan, interval },
      subscription_data: {
        metadata: { account_id: accountId, plan, interval },
        ...(withTrial
          ? {
              trial_period_days: TRIAL_DAYS,
              trial_settings: { end_behavior: { missing_payment_method: "cancel" as const } },
            }
          : {}),
      },
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
      ...(addTax
        ? {
            automatic_tax: { enabled: true },
            tax_id_collection: { enabled: true },
            ...(account?.stripe_customer_id
              ? { customer_update: { address: "auto" as const, name: "auto" as const } }
              : {}),
          }
        : {}),
      success_url: `${appUrl()}/checkout/complete?session_id={CHECKOUT_SESSION_ID}&next=${encodeURIComponent(checkoutDestination(returnTo))}`,
      cancel_url: `${appUrl()}/checkout/cancelled`,
    });
  } catch (err) {
    return billingFailure(err, "Checkout could not be opened");
  }

  if (session.status === "complete") return { ok: true, url: `${appUrl()}/checkout/complete?session_id=${session.id}&next=${encodeURIComponent(checkoutDestination(returnTo))}` };
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
  meta: { accountId: string; plan: SelfServePlan; interval: BillingInterval },
): Promise<void> {
  const stripe = getStripe();
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const item = sub.items?.data?.[0];
  if (!item) throw new Error("The current subscription has no plan item to change");
  if (item.price?.id === priceId) return;

  await stripe.subscriptions.update(subscriptionId, {
    items: [{ id: item.id, price: priceId }],
    proration_behavior: "create_prorations",
    metadata: { account_id: meta.accountId, plan: meta.plan, interval: meta.interval },
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
  const { accountId } = await requireAuth(["owner"]);
  const supabase = await createClient();

  const { data: account } = await supabase
    .from("accounts")
    .select("stripe_customer_id, stripe_subscription_id")
    .eq("id", accountId)
    .single();

  if (!account?.stripe_customer_id) {
    return { ok: false, error: "There is no billing account yet — choose a plan first." };
  }

  const returnUrl = `${appUrl()}/settings/billing`;
  const base = { customer: account.stripe_customer_id, return_url: returnUrl };

  try {
    if (flow === "cancel") {
      if (!account.stripe_subscription_id) {
        return { ok: false, error: "There is no active subscription to cancel." };
      }
      const session = await getStripe().billingPortal.sessions.create({
        ...base,
        flow_data: {
          type: "subscription_cancel",
          subscription_cancel: { subscription: account.stripe_subscription_id },
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
