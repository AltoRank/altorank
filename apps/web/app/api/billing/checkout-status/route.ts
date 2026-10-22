import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe";
import { activateCheckout, awaitingActivation, readCheckoutSubscription, type CheckoutAccount } from "@/lib/billing/activate-checkout";
import { recordEvent } from "@/lib/observability/record";

/**
 * Where the return from checkout stands, and the activation itself when the
 * webhook has not done it yet.
 *
 * The account used to go `trialing` only when Stripe's webhook arrived. A
 * webhook that was late, misconfigured or failing left the person on the free
 * plan after a "taking longer than expected", while Stripe held a trialing
 * subscription that charges on day eight. So the first poll after a completed
 * checkout records it (lib/billing/activate-checkout.ts), from the
 * subscription as Stripe has it, and the webhook finds nothing left to do.
 */
export async function GET(request: NextRequest) {
  let accountId: string;
  try { ({ accountId } = await requireAuth()); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  const id = request.nextUrl.searchParams.get("session_id");
  if (!id || !/^cs_[a-zA-Z0-9_]+$/.test(id)) return NextResponse.json({ error: "Invalid checkout session" }, { status: 400 });
  try {
    const session = await getStripe().checkout.sessions.retrieve(id);
    if (session.client_reference_id !== accountId) return NextResponse.json({ error: "Checkout not found" }, { status: 404 });
    const db = await createClient();
    const readAccount = async () => {
      const { data, error } = await db.from("accounts").select("stripe_subscription_id, plan_status, trial_ends_at").eq("id", accountId).single();
      if (error) throw error;
      return data as CheckoutAccount | null;
    };
    let account = await readAccount();

    const pending = awaitingActivation(session, account);
    if (pending) {
      const subscription = await readCheckoutSubscription(pending);
      const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
      const named = subscription.metadata?.account_id ?? session.metadata?.account_id;
      // Only a subscription Stripe says is running, on this account. One that
      // is still `incomplete` (a card being confirmed) is left to the webhook.
      if (customerId && (subscription.status === "trialing" || subscription.status === "active") && (!named || named === accountId)) {
        // As AltoRank: the billing columns are refused to a signed-in user
        // (migration 072). The account is the one signed in, and the session
        // was checked to be its own above.
        const service = createServiceClient();
        const outcome = await activateCheckout(service, { accountId, customerId, subscription, hints: session.metadata });
        if (outcome.recorded) {
          // Not an error: the person usually lands here a moment before
          // Stripe's webhook. Counted so that a webhook which never arrives
          // shows up as every activation coming from this page.
          await recordEvent({
            level: "info",
            source: "billing.checkout",
            message: `Checkout recorded from the return page before Stripe's webhook (${outcome.trialEndsAt ? "trialing" : "active"})`,
            accountId,
            context: { subscription: pending, owed: outcome.owed, paced: outcome.paced },
          }, service);
        }
        account = await readAccount();
      }
    }

    const subscription = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
    const entitled = account?.plan_status === "active" || (account?.plan_status === "trialing" && Date.parse(account.trial_ends_at ?? "") > Date.now());
    return NextResponse.json({ status: session.status, active: Boolean(session.status === "complete" && subscription && subscription === account?.stripe_subscription_id && entitled) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error(`[billing] checkout-status ${id}: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ error: "Activation could not be checked. Please retry." }, { status: 503 });
  }
}
