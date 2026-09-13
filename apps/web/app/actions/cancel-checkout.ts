"use server";
import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth/require-auth";
import { createServiceClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe";
import { checkoutWasRejected, createPendingCheckout } from "@/lib/billing/checkout-attempt";

export async function cancelPendingCheckout() {
  const { accountId } = await requireAuth(["owner"]);
  const db = createServiceClient();
  const { data: attempt, error } = await db.from("billing_checkout_attempts").select("id, stripe_session_id, parameters").eq("account_id", accountId).maybeSingle();
  if (error) throw new Error("Could not read checkout. Please retry.");
  if (attempt) {
    let session;
    try {
      // A lost create response may have made a real session. Resolve the same
      // idempotent attempt before cancelling, never discard an uncertain one.
      session = attempt.stripe_session_id
        ? await getStripe().checkout.sessions.retrieve(attempt.stripe_session_id)
        : await createPendingCheckout(accountId, attempt.parameters);
    } catch (error) {
      if (checkoutWasRejected(error)) redirect("/onboarding?status=cancelled");
      throw error;
    }
    if (session.client_reference_id !== accountId) throw new Error("Checkout does not belong to this account.");
    if (session.status === "complete") redirect(`/checkout/complete?session_id=${session.id}`);
    if (session.status === "open") await getStripe().checkout.sessions.expire(session.id);
    const removed = await db.from("billing_checkout_attempts").delete().eq("account_id", accountId).eq("id", attempt.id);
    if (removed.error) throw new Error("Checkout is closed. Please retry to clear it.");
  }
  redirect("/onboarding?status=cancelled");
}
