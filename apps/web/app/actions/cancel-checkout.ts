"use server";
import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth/require-auth";
import { createServiceClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe";
import { attemptAbandoned } from "@/lib/billing/checkout-attempt";
import { cancelledCheckoutReturn } from "@/lib/billing/checkout-return";

/**
 * Close the account's open checkout and go back to where it was opened from.
 *
 * `next` comes from the cancel page's form: "/settings/billing" for a
 * purchase started on Billing, the trial screen otherwise. Checked against
 * the same-origin rule as every other post-checkout destination.
 */
export async function cancelPendingCheckout(formData?: FormData) {
  const { accountId } = await requireAuth(["owner"]);
  const back = cancelledCheckoutReturn(formData?.get("next"));
  const db = createServiceClient();
  const { data: attempt, error } = await db.from("billing_checkout_attempts").select("id, stripe_session_id, expires_at").eq("account_id", accountId).maybeSingle();
  if (error) throw new Error("Could not read checkout. Please retry.");
  if (attempt) {
    if (!attempt.stripe_session_id) {
      // A reservation whose session was never saved: a create that threw or
      // died. There is no session to close, and refusing here ("still
      // opening") was the second half of the lockout - the one button meant
      // to clear it threw for ever.
      if (!attemptAbandoned(attempt)) throw new Error("Checkout is still opening. Please retry in a moment.");
    } else {
      const session = await getStripe().checkout.sessions.retrieve(attempt.stripe_session_id);
      if (session.client_reference_id !== accountId) throw new Error("Checkout does not belong to this account.");
      if (session.status === "complete") redirect(`/checkout/complete?session_id=${session.id}`);
      if (session.status === "open") await getStripe().checkout.sessions.expire(session.id);
    }
    const removed = await db.from("billing_checkout_attempts").delete().eq("account_id", accountId).eq("id", attempt.id);
    if (removed.error) throw new Error("Checkout is closed. Please retry to clear it.");
  }
  redirect(back);
}
