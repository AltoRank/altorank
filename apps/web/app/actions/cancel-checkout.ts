"use server";
import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth/require-auth";
import { createServiceClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe";

export async function cancelPendingCheckout() {
  const { accountId } = await requireAuth(["owner"]);
  const db = createServiceClient();
  const { data: attempt, error } = await db.from("billing_checkout_attempts").select("id, stripe_session_id").eq("account_id", accountId).maybeSingle();
  if (error) throw new Error("Could not read checkout. Please retry.");
  if (attempt) {
    if (!attempt.stripe_session_id) throw new Error("Checkout is still opening. Please retry in a moment.");
    const session = await getStripe().checkout.sessions.retrieve(attempt.stripe_session_id);
    if (session.client_reference_id !== accountId) throw new Error("Checkout does not belong to this account.");
    if (session.status === "complete") redirect(`/checkout/complete?session_id=${session.id}`);
    if (session.status === "open") await getStripe().checkout.sessions.expire(session.id);
    const removed = await db.from("billing_checkout_attempts").delete().eq("account_id", accountId).eq("id", attempt.id);
    if (removed.error) throw new Error("Checkout is closed. Please retry to clear it.");
  }
  redirect("/onboarding?status=cancelled");
}
