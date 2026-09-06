// ---------------------------------------------------------------------------
// What a billing action says when Stripe refuses
// ---------------------------------------------------------------------------
//
// Every action on the Billing page used to throw, and Next.js replaces a
// thrown server-action message with an opaque digest in production. So on
// app.altorank.co a failed "Choose Managed", a failed portal link and a failed
// cancellation all reached the person as a hex string, and the buttons that
// take money were the ones with no way to report why they had not.
//
// `createWorkspace` already learned this and wrote it down: "a refusal the
// user can read has to travel as data" (app/actions/workspaces.ts). These
// actions now return a result the same way.
//
// The message is ours, not Stripe's. Driving the local stack against an
// invalid key surfaced "Invalid API Key provided: sk_test_********ess2" into
// the cancellation dialog - a sentence that means nothing to a customer,
// names our own configuration, and is not something they can act on. What
// they can act on is: nothing was charged, and here is what to do next.

/** What a billing action that ends in a redirect returns. */
export type BillingRedirect = { ok: true; url: string } | { ok: false; error: string };

/** What a billing action that only writes returns. */
export type BillingOutcome<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/**
 * Turn a Stripe (or any) failure into a sentence for the person who pressed
 * the button, and log the real one for us.
 *
 * `what` is the half that differs - "Checkout could not be opened", "The plan
 * could not be switched" - and the rest is the same in every case, because it
 * is the same two facts: no money moved, and support can see what happened.
 */
export function billingFailure(err: unknown, what: string): { ok: false; error: string } {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(`[billing] ${what}: ${detail}`);
  return {
    ok: false,
    error: `${what}. Nothing has been charged and nothing about your account has changed. Try again in a moment; if it keeps happening, email hello@altorank.co and we will sort it out.`,
  };
}
