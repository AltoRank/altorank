import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { createServiceClient } from "@/lib/supabase/server";

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
