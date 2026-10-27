import { requireAuth } from "@/lib/auth/require-auth";
import { CheckoutActivation } from "@/components/billing/checkout-activation";
import { billingReturnPath, checkoutDestination, TRIAL_GATE_PATH } from "@/lib/billing/checkout-return";
import { accountTrialGate } from "@/lib/billing/body-lock";
import { createClient } from "@/lib/supabase/server";
import { TrackStep } from "@/components/onboarding/track-step";

export default async function CheckoutComplete({ searchParams }: { searchParams: Promise<{ session_id?: string; next?: string }> }) {
  const { accountId, user } = await requireAuth();
  const params = await searchParams;
  const destination = checkoutDestination(params.next);
  // The way back, for a checkout that did not complete: the trial screen for
  // an account still behind the gate, Billing for everyone else (the same
  // split as /checkout/cancelled). It always said "Back to trial options",
  // which for a paid account opened setup again.
  const gate = await accountTrialGate(await createClient(), accountId, user.email ?? null);
  const back = gate !== "open"
    ? { href: TRIAL_GATE_PATH, label: "Back to trial options", retry: "Go back to start the trial again." }
    : { href: billingReturnPath(destination), label: "Back to Billing", retry: "Go back to Billing to try again." };
  return (
    <>
      <TrackStep step="checkout_returned" />
      <CheckoutActivation sessionId={params.session_id ?? ""} destination={destination} back={back} />
    </>
  );
}
