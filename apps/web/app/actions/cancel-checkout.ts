"use server";
import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth/require-auth";
import { createServiceClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe";
import { attemptAbandoned } from "@/lib/billing/checkout-attempt";
import { cancelledCheckoutReturn } from "@/lib/billing/checkout-return";
import { billingFailure } from "@/lib/billing/failure";

/**
 * What the cancel page's form shows under its button: null until a press is
 * refused, then the sentence for it. A refusal travels as data because
 * production replaces a thrown action's message with an opaque digest
 * (lib/billing/failure.ts).
 */
export type CancelCheckoutState = { error: string } | null;

/**
 * Close the account's open checkout and go back to where it was opened from.
 *
 * `next` comes from the cancel page's form: "/settings/billing" for a
 * purchase started on Billing, the trial screen otherwise. Checked against
 * the same-origin rule as every other post-checkout destination. Redirects
 * when it is done; returns the reason when it could not be.
 */
export async function cancelPendingCheckout(_prev: CancelCheckoutState, formData?: FormData): Promise<CancelCheckoutState> {
  const { accountId } = await requireAuth(["owner"]);
  const back = cancelledCheckoutReturn(formData?.get("next"));
  const db = createServiceClient();
  const { data: attempt, error } = await db.from("billing_checkout_attempts").select("id, stripe_session_id, expires_at").eq("account_id", accountId).maybeSingle();
  if (error) return { error: "Your open checkout could not be read. Nothing was charged. Try again in a moment." };
  if (attempt) {
    if (!attempt.stripe_session_id) {
      // A reservation whose session was never saved: a create that threw or
      // died. There is no session to close, and refusing here ("still
      // opening") was the second half of the lockout - the one button meant
      // to clear it threw for ever.
      if (!attemptAbandoned(attempt)) return { error: "Checkout is still opening. Nothing was charged. Try again in a moment." };
    } else {
      let session;
      try {
        session = await getStripe().checkout.sessions.retrieve(attempt.stripe_session_id);
      } catch (err) {
        return { error: billingFailure(err, "Checkout could not be closed").error };
      }
      if (session.client_reference_id !== accountId) return { error: "This checkout belongs to another account, so it was left open. Nothing was charged here." };
      if (session.status === "complete") redirect(`/checkout/complete?session_id=${session.id}`);
      if (session.status === "open") {
        try {
          await getStripe().checkout.sessions.expire(session.id);
        } catch (err) {
          return { error: billingFailure(err, "Checkout could not be closed").error };
        }
      }
    }
    const removed = await db.from("billing_checkout_attempts").delete().eq("account_id", accountId).eq("id", attempt.id);
    if (removed.error) return { error: "Checkout is closed, but it could not be cleared here. Nothing was charged. Try again in a moment." };
  }
  redirect(back);
}
