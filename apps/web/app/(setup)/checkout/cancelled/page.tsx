import Link from "next/link";
import { requireAuth } from "@/lib/auth/require-auth";
import { CloseCheckoutForm } from "@/components/billing/close-checkout-form";
import { TrackStep } from "@/components/onboarding/track-step";
import { createClient } from "@/lib/supabase/server";
import { accountTrialGate } from "@/lib/billing/body-lock";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";
import { firstArticleTitle } from "@/lib/onboarding/first-article";
import { billingReturnPath, checkoutDestination, STRIPE_CANCEL_MARK, TRIAL_CANCELLED_PATH, TRIAL_GATE_PATH } from "@/lib/billing/checkout-return";

/**
 * Stripe's cancel link lands here, from the trial screen and from Billing
 * alike. It used to tell everyone "your first article and plan are saved ...
 * start the same trial" and send them to the trial screen, which has no offer
 * for an account past it - so a customer who left a Billing checkout was
 * taken out of Billing and shown copy about a trial they could not start.
 *
 * The trial script is for an account whose gate is not open: gated, or an
 * address that bypasses the gate to test it. Everyone else goes back to
 * Billing, with the destination the purchase was for.
 *
 * Only Stripe's back link carries `from=stripe` (app/actions/billing.ts). The
 * "Manage open checkout" link under a checkout error lands here without it,
 * so only the marker says "You left checkout" and records checkout_cancelled.
 * Either way the trial script has one way back: to the article on the trial
 * screen, closing the open checkout on the way for an owner - and, when that
 * close is refused, a plain link to the same place under the reason.
 */
export default async function CheckoutCancelled(props: { searchParams?: Promise<{ next?: string; from?: string }> }) {
  const { role, accountId, user } = await requireAuth();
  const params = await props.searchParams;
  const supabase = await createClient();
  const gate = await accountTrialGate(supabase, accountId, user.email ?? null);

  if (gate !== "open") {
    const left = params?.from === STRIPE_CANCEL_MARK;
    // The trial screen shows its "Checkout was cancelled" notice, and records
    // the step again for the site, only when Stripe's page was left.
    const back = left ? TRIAL_CANCELLED_PATH : TRIAL_GATE_PATH;
    const scopeId = await getScopedWorkspaceId();
    const title = scopeId ? await firstArticleTitle(supabase, scopeId) : null;
    // No written article yet (still being written, or setup stopped): the
    // page does not promise one.
    const label = title ? "Back to my article" : "Go back";
    const lede = left
      ? title ? "Nothing was charged. Your article is still here." : "Nothing was charged."
      : `Going back closes any checkout that is still open, so you can start the trial again${title ? " from your article" : ""}.`;

    return <main className="mx-auto max-w-xl px-6 py-16">
      {left && <TrackStep step="checkout_cancelled" />}
      <h1 className="mb-3 text-2xl font-semibold">{left ? "You left checkout." : "Nothing was charged."}</h1>
      <p className="mb-6 text-ink-2">{lede}</p>
      {title && (
        <div className="mb-6 rounded-[10px] border border-line bg-panel px-4 py-3.5">
          <div className="text-[12px] text-ink-3">Your first article</div>
          <div className="mt-1 text-[15px] font-semibold leading-snug text-ink">{title}</div>
        </div>
      )}
      {role === "owner" ? (
        <CloseCheckoutForm next={back} label={label} leave={title ? "Go to my article without closing it" : "Go back without closing it"} />
      ) : (
        <Link
          href={back}
          className="inline-flex h-8 items-center rounded-[7px] border border-accent bg-accent px-3 text-[13px] font-medium text-white hover:border-accent-2 hover:bg-accent-2"
        >
          {label}
        </Link>
      )}
    </main>;
  }

  const back = billingReturnPath(checkoutDestination(params?.next));
  return <main className="mx-auto max-w-xl px-6 py-16">
    <h1 className="mb-4 text-2xl font-semibold">Checkout was cancelled</h1>
    <p className="mb-6">You left checkout, and nothing was charged. Your plan and everything in the account are as they were. Close it to choose a different plan or billing interval on Billing.</p>
    {role === "owner" && <CloseCheckoutForm next={back} label="Cancel checkout and return" look="link" />}
    <Link className="text-accent underline" href={back}>Back to Billing</Link>
  </main>;
}
