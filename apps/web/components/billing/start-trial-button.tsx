"use client";

import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui";
import { createCheckoutSession } from "@/app/actions/billing";
import { PLAN_LABELS, PLAN_PRICES, PLAN_YEARLY_PRICES, TRIAL_DAYS, type BillingInterval, type SelfServePlan } from "@/lib/stripe";
import { CheckoutSheet, EmbeddedCheckoutForm, embeddedCheckoutAvailable } from "./embedded-checkout";
import { CANCEL_LINE } from "@/lib/billing/trial-offer";
import { trackStep } from "@/lib/onboarding/track-step";
import { currentViewport, type CheckoutClose, type CheckoutFailure, type TrialSurface } from "@/lib/onboarding/step-props";

/**
 * The one button that opens the trial's checkout: card required, seven days
 * before the first charge, Managed and monthly unless told otherwise.
 * Everywhere the trial is offered renders this so the offer and the checkout
 * it opens cannot drift. TrialOffer passes the plan and interval chosen on it.
 *
 * With a publishable key the card is taken on this page, in Stripe's Embedded
 * Checkout (./embedded-checkout.tsx): in a sheet over the page by default, or
 * in place of the button with `embed="inline"` (the gate's side rail, so the
 * form sits beside the article rather than over it). Without one, the button
 * goes to Stripe's hosted page as it always did.
 */
export function StartTrialButton({
  returnTo,
  plan = "starter",
  interval = "month",
  label = "Start 7-day trial",
  variant = "accent",
  className,
  onError,
  surface,
  embed = "sheet",
}: {
  /** Same-origin path to land on after the card is taken. */
  returnTo?: string;
  /** Which plan to trial: Managed by default, Agency when chosen. */
  plan?: SelfServePlan;
  /** Which price to open checkout on. Yearly is two months free (lib/stripe). */
  interval?: BillingInterval;
  label?: string;
  variant?: "accent" | "default";
  className?: string;
  /**
   * Also surface the failure in the page itself. A toast is enough beside the
   * other places the trial is offered; on a screen with nothing else on it,
   * the error needs somewhere to stay.
   */
  onError?: (message: string) => void;
  /**
   * Which trial button this is, for onboarding.step: the press
   * (`trial_clicked`), and when it does not become a trial, how the form
   * was left (`checkout_closed`) or where it stopped (`checkout_failed`).
   * Without one nothing is recorded.
   */
  surface?: TrialSurface;
  /** Where Stripe's form opens when it can open on the page: a sheet, or in place of the button. */
  embed?: "sheet" | "inline";
}) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  // Where focus goes back to when the sheet closes.
  const opener = useRef<HTMLButtonElement | null>(null);
  // The Stripe session the open form is on, once it has one: what tells
  // one attempt's events from the next (lib/onboarding/step-props.ts stepKey).
  const session = useRef<string | undefined>(undefined);
  const pressed = () => {
    session.current = undefined;
    if (surface) trackStep("trial_clicked", { props: { surface, plan, interval } });
  };
  const failed = (stage: CheckoutFailure) => {
    if (surface) trackStep("checkout_failed", { checkoutSession: session.current, props: { stage, surface, viewport: currentViewport() } });
  };
  const leave = (how: CheckoutClose) => {
    if (surface) trackStep("checkout_closed", { checkoutSession: session.current, props: { how, surface, viewport: currentViewport() } });
    setOpen(false);
  };
  const fail = (message: string, stage: CheckoutFailure) => {
    failed(stage);
    onError?.(message);
    toast.error(message);
    setOpen(false);
  };

  if (embeddedCheckoutAvailable) {
    const price = interval === "month" ? `${PLAN_PRICES[plan]} per month` : `${PLAN_YEARLY_PRICES[plan]} per year`;
    const form = (
      <EmbeddedCheckoutForm key={`${plan}-${interval}`} plan={plan} interval={interval} returnTo={returnTo} onError={fail} onSession={(id) => (session.current = id)} />
    );
    if (embed === "inline" && open) {
      return (
        <div className="flex flex-col gap-2">
          {form}
          <button type="button" onClick={() => leave("not_now")} className="self-center text-[12.5px] text-ink-3 underline decoration-line underline-offset-[3px] hover:text-ink-2">
            Not now
          </button>
        </div>
      );
    }
    return (
      <>
        <Button
          variant={variant}
          className={className}
          onClick={(e) => {
            opener.current = e.currentTarget;
            pressed();
            setOpen(true);
          }}
        >
          {label}
        </Button>
        {embed === "sheet" && (
          <CheckoutSheet
            open={open}
            onClose={leave}
            opener={opener}
            title={`Start your ${TRIAL_DAYS}-day trial`}
            lede={`${PLAN_LABELS[plan]}: €0 today, then ${price}. ${CANCEL_LINE}`}
          >
            {form}
          </CheckoutSheet>
        )}
      </>
    );
  }

  return (
    <Button
      variant={variant}
      disabled={pending}
      className={className}
      onClick={() => {
        pressed();
        start(async () => {
          // The action returns {ok:false} for the failures it predicts, and
          // throws for the ones it does not - no Stripe key, a price id that
          // no longer exists, Stripe itself down. A throw inside a transition
          // is swallowed, so the button simply did nothing and said nothing.
          // That was survivable while this was one offer among many; behind
          // the trial gate it is the only control on a screen the person
          // cannot leave, so a silent failure locks them out of the product.
          try {
            const result = await createCheckoutSession(plan, interval, returnTo);
            if (!result.ok) {
              failed("create");
              onError?.(result.error);
              toast.error(result.error);
              return;
            }
            window.location.href = result.url;
          } catch {
            failed("create");
            const message = "Checkout could not be opened. Please try again, or contact us if it keeps happening.";
            onError?.(message);
            toast.error(message);
          }
        });
      }}
    >
      {pending ? "Opening checkout…" : label}
    </Button>
  );
}
