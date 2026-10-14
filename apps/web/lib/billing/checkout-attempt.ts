import type Stripe from "stripe";
import { createServiceClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe";

/** How long a Checkout session stays open, in seconds. */
export const CHECKOUT_TTL_SECONDS = 3600;

/**
 * A reservation with no Stripe session after this long is a create that died.
 *
 * Opening a session takes seconds. A row still without one minutes later
 * belongs to a `checkout.sessions.create` that threw, or to a process that
 * stopped between the reservation and saving the session id. Its session URL
 * (if Stripe made one at all) never reached the person, so nothing is lost by
 * starting again - and keeping it locked the account out of checkout for good:
 * every retry replayed the same frozen parameters and idempotency key, and
 * from half an hour on Stripe refused the frozen `expires_at` as too close.
 */
export const ABANDONED_ATTEMPT_MS = 5 * 60 * 1000;

type AttemptRow = { id: string; expires_at: string | null; stripe_session_id: string | null };

/** Whether a reservation with no session is old enough to be a create that died. */
export function attemptAbandoned(attempt: Pick<AttemptRow, "expires_at" | "stripe_session_id">, now: number = Date.now()): boolean {
  if (attempt.stripe_session_id) return false;
  const expires = attempt.expires_at ? Date.parse(attempt.expires_at) : NaN;
  // No readable date: nothing says it is fresh, and a row that cannot be
  // aged would otherwise hold the account forever.
  if (Number.isNaN(expires)) return true;
  const reservedAt = expires - CHECKOUT_TTL_SECONDS * 1000;
  return now - reservedAt >= ABANDONED_ATTEMPT_MS;
}

/** Thrown when a checkout is still opening for a different price. */
export const CHECKOUT_OPENING_MESSAGE =
  "A checkout is still opening in another tab or window. Wait a moment and try again.";

/** The guard against a delete that did not take: never more than this many fresh starts in one call. */
const MAX_RESTARTS = 2;

export async function createPendingCheckout(
  accountId: string,
  parameters: Stripe.Checkout.SessionCreateParams,
  restarts = 0,
): Promise<Stripe.Checkout.Session> {
  if (restarts > MAX_RESTARTS) throw new Error("Checkout could not be reset. Please try again.");
  const db = createServiceClient();
  const expires = Math.floor(Date.now() / 1000) + CHECKOUT_TTL_SECONDS;
  const { data, error } = await db.rpc("claim_checkout_attempt", { p_account_id: accountId, p_parameters: { ...parameters, expires_at: expires }, p_expires_at: new Date(expires * 1000).toISOString() });
  const attempt = data?.[0];
  if (error || !attempt) throw new Error("Checkout could not be reserved. Please try again.");
  const held = attempt.parameters as Stripe.Checkout.SessionCreateParams;
  const samePrice = held.line_items?.[0]?.price === parameters.line_items?.[0]?.price;

  async function clear(onlyWithoutSession: boolean): Promise<void> {
    let query = db.from("billing_checkout_attempts").delete().eq("account_id", accountId).eq("id", attempt.id);
    if (onlyWithoutSession) query = query.is("stripe_session_id", null);
    const removed = await query;
    if (removed.error) throw new Error("Could not clear the closed checkout. Please retry.");
  }

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
    // Still open, for another plan or interval: the person left Stripe with
    // the browser's Back button and chose again. That used to refuse with
    // "another plan is already open", which the Billing page turned into
    // "try again in a moment" for up to an hour, with no control to clear it.
    // Close the old session - nobody can pay on it after this - and open the
    // one they asked for.
    if (!terminal && !samePrice && existing.status === "open") {
      await getStripe().checkout.sessions.expire(existing.id);
      terminal = true;
    }
    if (terminal) {
      await clear(false);
      // A concurrent caller claims the same next attempt through the unique row.
      return createPendingCheckout(accountId, parameters, restarts + 1);
    }
  } else if (attemptAbandoned(attempt)) {
    // Only while it still has no session: a slow create that saved one a
    // moment ago is not abandoned.
    await clear(true);
    return createPendingCheckout(accountId, parameters, restarts + 1);
  }

  // A reservation for another price whose create is in flight right now.
  if (!samePrice) throw new Error(CHECKOUT_OPENING_MESSAGE);

  let session: Stripe.Checkout.Session;
  try {
    session = await getStripe().checkout.sessions.create(held, { idempotencyKey: `checkout:${attempt.id}` });
  } catch (err) {
    // Stripe refused or could not be reached. Release the reservation so the
    // next press starts over with a fresh key and a fresh `expires_at`,
    // instead of replaying this exact request into the same refusal.
    try {
      await clear(true);
    } catch {
      // The abandoned-row rule above releases it in a few minutes anyway.
    }
    throw err;
  }
  const saved = await db.from("billing_checkout_attempts").update({ stripe_session_id: session.id }).eq("account_id", accountId).eq("id", attempt.id);
  if (saved.error) throw new Error("Checkout was created but could not be saved. Retry to resume the same checkout.");
  return session;
}
