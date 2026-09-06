import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripe, isSelfServePlan, planForPriceId, type SelfServePlan } from "@/lib/stripe";
import { createServiceClient } from "@/lib/supabase/server";
import { paceOnActivation } from "@/lib/content/pace";

function mapStatus(s: Stripe.Subscription.Status): string {
  switch (s) {
    case "active":
    case "trialing":
    case "past_due":
    case "canceled":
      return s;
    case "incomplete":
    case "incomplete_expired":
    case "unpaid":
    case "paused":
      return "past_due";
    default:
      return "inactive";
  }
}

/**
 * Which tier a completed checkout bought.
 *
 * `checkout.session.completed` carries no line items, so the price has to be
 * read off the subscription the session created. That read is the authoritative
 * answer - it is what Stripe bills - and `session.metadata.plan`, written by
 * `createCheckoutSession`, is the fallback for when the read fails or returns a
 * price id this deployment does not recognise.
 *
 * This exists because the handler used to write `stripe_customer_id`,
 * `stripe_subscription_id` and `plan_status` and *not* `plan`. `agencies.plan`
 * is `not null default 'starter'`, so a EUR 199 Agency buyer sat on Managed's
 * row - badged "Managed plan" on the Billing page and metered at
 * PLAN_ARTICLE_LIMITS.starter = 100 instead of 400, which also capped the pace
 * they were allowed to set - until some later `customer.subscription.updated`
 * happened to arrive and correct it (2026-09-06).
 */
export async function planForCheckoutSession(
  session: Stripe.Checkout.Session,
): Promise<SelfServePlan | undefined> {
  const subscriptionId =
    typeof session.subscription === "string" ? session.subscription : session.subscription?.id;

  if (subscriptionId) {
    try {
      const sub = await getStripe().subscriptions.retrieve(subscriptionId);
      const fromPrice = planForPriceId(sub.items?.data?.[0]?.price?.id);
      if (fromPrice) return fromPrice;
    } catch {
      // Fall through to the metadata hint. A Stripe read that fails must not
      // cost us the plan write; leaving the row on the default is the bug.
    }
  }

  const hint = session.metadata?.plan;
  return isSelfServePlan(hint) ? hint : undefined;
}

/**
 * Stripe webhook. Signature-verified, then syncs subscription state into the
 * existing agencies.{plan, plan_status, stripe_*, current_period_end} columns.
 * The verified event is the only trusted input — never trust unsigned fields.
 */
export async function POST(request: Request) {
  const body = await request.text();
  const sig = request.headers.get("stripe-signature");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !secret) {
    return NextResponse.json({ error: "Missing signature/secret" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(body, sig, secret);
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const supabase = createServiceClient();

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const agencyId = session.metadata?.agency_id ?? session.client_reference_id ?? undefined;
      if (agencyId && session.customer && session.subscription) {
        const plan = await planForCheckoutSession(session);

        await supabase
          .from("agencies")
          .update({
            stripe_customer_id: String(session.customer),
            stripe_subscription_id: String(session.subscription),
            plan_status: "active",
            // The tier the money bought. Omitted only when neither the
            // subscription's price nor the session metadata resolved to a
            // plan we sell, in which case the later subscription event is the
            // last line of defence rather than the first.
            ...(plan ? { plan } : {}),
          })
          .eq("id", agencyId);

        /**
         * Start writing at a paid pace.
         *
         * Signup sets one article a week, which is right while the account is
         * free: the quota allows one draft a calendar month, so a higher pace
         * would only make the cron attempt work the quota gate then refuses.
         * Nothing raised it afterwards, so a customer who paid for 100 a month
         * kept getting about four, and there was no control anywhere to change
         * it. `paceOnActivation` only ever raises, and only from a value the
         * product itself chose - a site deliberately paused at 0, or set to
         * anything above the free-tier pace, is left alone.
         */
        const { data: sites } = await supabase
          .from("workspaces")
          .select("id, auto_generate_weekly_limit")
          .eq("agency_id", agencyId);
        for (const site of sites ?? []) {
          const next = paceOnActivation(site.auto_generate_weekly_limit as number | null, plan);
          if (next === null) continue;
          await supabase
            .from("workspaces")
            .update({ auto_generate_weekly_limit: next })
            .eq("id", site.id);
        }
      }
      break;
    }

    // `created` fires for every new subscription, including ones that never
    // went through our checkout (a subscription started from the Stripe
    // dashboard, or a plan switch that replaces rather than updates). Handled
    // with `updated` because the work is identical: resolve the price to a
    // tier and write it.
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const priceId = sub.items.data[0]?.price.id;
      const hint = sub.metadata?.plan;
      const plan = planForPriceId(priceId) ?? (isSelfServePlan(hint) ? hint : undefined);
      const periodEnd = (sub as unknown as { current_period_end?: number }).current_period_end;

      const status =
        event.type === "customer.subscription.deleted" ? "canceled" : mapStatus(sub.status);

      const updates: Record<string, unknown> = {
        ...(periodEnd ? { current_period_end: new Date(periodEnd * 1000).toISOString() } : {}),
        ...(plan ? { plan } : {}),
        // Cancel-at-period-end set from the Billing page or from the portal
        // both land here; the page reads this column to say when the plan
        // ends. Cleared when the cancellation is undone.
        cancels_at:
          event.type === "customer.subscription.deleted"
            ? null
            : sub.cancel_at_period_end && sub.cancel_at
              ? new Date(sub.cancel_at * 1000).toISOString()
              : null,
      };

      if (event.type === "customer.subscription.created") {
        // A new subscription is also where the customer and subscription ids
        // first exist for a purchase that did not come through our checkout.
        if (sub.customer) {
          updates.stripe_customer_id =
            typeof sub.customer === "string" ? sub.customer : sub.customer.id;
          updates.stripe_subscription_id = sub.id;
        }
        // `created` states what was bought, not whether it is paid for. Stripe
        // does not order it against `checkout.session.completed`, and a card
        // that needed 3-D Secure creates the subscription `incomplete`, so
        // writing that status here could arrive after the checkout handler and
        // knock a live account back to past_due. Only a status that is already
        // good is worth writing; anything else waits for `updated`.
        if (status === "active" || status === "trialing") updates.plan_status = status;
      } else {
        updates.plan_status = status;
      }

      const agencyId = sub.metadata?.agency_id;
      if (agencyId) {
        await supabase.from("agencies").update(updates).eq("id", agencyId);
      } else {
        // Fall back to matching by the stored subscription id.
        await supabase.from("agencies").update(updates).eq("stripe_subscription_id", sub.id);
      }
      break;
    }
  }

  return NextResponse.json({ received: true });
}
