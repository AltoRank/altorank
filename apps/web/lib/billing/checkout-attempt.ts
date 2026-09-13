import type Stripe from "stripe";
import { createServiceClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe";

export async function createPendingCheckout(accountId: string, parameters: Stripe.Checkout.SessionCreateParams): Promise<Stripe.Checkout.Session> {
  const db = createServiceClient();
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const { data, error } = await db.rpc("claim_checkout_attempt", { p_account_id: accountId, p_parameters: { ...parameters, expires_at: expires }, p_expires_at: new Date(expires * 1000).toISOString() });
  const attempt = data?.[0];
  if (error || !attempt) throw new Error("Checkout could not be reserved. Please try again.");
  if (attempt.stripe_session_id) {
    const existing = await getStripe().checkout.sessions.retrieve(attempt.stripe_session_id);
    if (existing.client_reference_id !== accountId) throw new Error("Checkout account does not match.");
    let terminal = existing.status === "expired";
    if (existing.status === "complete") {
      const subId = typeof existing.subscription === "string" ? existing.subscription : existing.subscription?.id;
      if (!subId) return existing;
      const subscription = await getStripe().subscriptions.retrieve(subId);
      terminal = subscription.status === "canceled" || subscription.status === "incomplete_expired";
      if (!terminal) return existing;
    }
    if (terminal) {
      const removed = await db.from("billing_checkout_attempts").delete().eq("account_id", accountId).eq("id", attempt.id);
      if (removed.error) throw new Error("Could not clear the closed checkout. Please retry.");
      // A concurrent caller claims the same next attempt through the unique row.
      return createPendingCheckout(accountId, parameters);
    }
  }
  const held = attempt.parameters as Stripe.Checkout.SessionCreateParams;
  if (held.line_items?.[0]?.price !== parameters.line_items?.[0]?.price) throw new Error("A checkout for another plan is already open. Cancel that checkout before choosing a different plan.");
  const session = await getStripe().checkout.sessions.create(held, { idempotencyKey: `checkout:${attempt.id}` });
  const saved = await db.from("billing_checkout_attempts").update({ stripe_session_id: session.id }).eq("account_id", accountId).eq("id", attempt.id);
  if (saved.error) throw new Error("Checkout was created but could not be saved. Retry to resume the same checkout.");
  return session;
}
