import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { createServiceClient } from "@/lib/supabase/server";
import { paceOnActivation } from "@/lib/content/pace";

// Resolve a Stripe price id back to our plan tier.
function planForPrice(priceId: string | undefined): "starter" | "growth" | undefined {
  if (!priceId) return undefined;
  if (
    priceId === process.env.STRIPE_PRICE_STARTER ||
    priceId === process.env.STRIPE_PRICE_STARTER_YEARLY
  )
    return "starter";
  if (
    priceId === process.env.STRIPE_PRICE_GROWTH ||
    priceId === process.env.STRIPE_PRICE_GROWTH_YEARLY
  )
    return "growth";
  return undefined;
}

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
        await supabase
          .from("agencies")
          .update({
            stripe_customer_id: String(session.customer),
            stripe_subscription_id: String(session.subscription),
            plan_status: "active",
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
          const next = paceOnActivation(site.auto_generate_weekly_limit as number | null);
          if (next === null) continue;
          await supabase
            .from("workspaces")
            .update({ auto_generate_weekly_limit: next })
            .eq("id", site.id);
        }
      }
      break;
    }

    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const priceId = sub.items.data[0]?.price.id;
      const plan = planForPrice(priceId);
      const periodEnd = (sub as unknown as { current_period_end?: number }).current_period_end;

      const updates: Record<string, unknown> = {
        plan_status:
          event.type === "customer.subscription.deleted" ? "canceled" : mapStatus(sub.status),
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
