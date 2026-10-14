import Link from "next/link";
import { requireAuth } from "@/lib/auth/require-auth";
import { cancelPendingCheckout } from "@/app/actions/cancel-checkout";
import { createClient } from "@/lib/supabase/server";
import { accountTrialGate } from "@/lib/billing/body-lock";
import { billingReturnPath, checkoutDestination, TRIAL_CANCELLED_PATH } from "@/lib/billing/checkout-return";

/**
 * Stripe's cancel link lands here, from the trial screen and from Billing
 * alike. It used to tell everyone "your first article and plan are saved ...
 * start the same trial" and send them to the trial screen, which has no offer
 * for an account past it - so a customer who left a Billing checkout was
 * taken out of Billing and shown copy about a trial they could not start.
 *
 * The trial script is for an account still behind the trial gate. Everyone
 * else goes back to Billing, with the destination the purchase was for.
 */
export default async function CheckoutCancelled(props: { searchParams?: Promise<{ next?: string }> }) {
  const { role, accountId, user } = await requireAuth();
  const next = checkoutDestination((await props.searchParams)?.next);
  const gated = (await accountTrialGate(await createClient(), accountId, user.email ?? null)) === "gated";
  const back = gated ? TRIAL_CANCELLED_PATH : billingReturnPath(next);

  return <main className="mx-auto max-w-xl px-6 py-16">
    {gated ? <>
      <h1 className="mb-4 text-2xl font-semibold">Your first article and plan are saved</h1>
      <p className="mb-6">You left checkout, and nothing was charged. Close it to choose another plan, or go back and start the same trial.</p>
    </> : <>
      <h1 className="mb-4 text-2xl font-semibold">Checkout was cancelled</h1>
      <p className="mb-6">You left checkout, and nothing was charged. Your plan and everything in the account are as they were. Close it to choose a different plan or billing interval on Billing.</p>
    </>}
    {role === "owner" && <form action={cancelPendingCheckout}><input type="hidden" name="next" value={back} /><button className="mb-5 text-accent underline">Cancel checkout and return</button></form>}
    <Link className="text-accent underline" href={back}>{gated ? "Back to trial options" : "Back to Billing"}</Link>
  </main>;
}
