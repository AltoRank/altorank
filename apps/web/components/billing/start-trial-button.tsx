"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui";
import { createCheckoutSession } from "@/app/actions/billing";
import type { BillingInterval } from "@/lib/stripe";

/**
 * The one button that opens the trial's checkout: Managed, monthly, card
 * required, seven days before the first charge. Everywhere the trial is
 * offered renders this so the offer and the checkout it opens cannot drift.
 * Yearly and Agency are a click away on Billing, where the ladder is.
 */
export function StartTrialButton({
  returnTo,
  interval = "month",
  label = "Start 7-day trial",
  variant = "accent",
  className,
  onError,
}: {
  /** Same-origin path to land on after the card is taken. */
  returnTo?: string;
  /** Which price to open checkout on. Yearly is two months free (lib/stripe). */
  interval?: BillingInterval;
  label?: string;
  variant?: "accent" | undefined;
  className?: string;
  /**
   * Also surface the failure in the page itself. A toast is enough beside the
   * other places the trial is offered; on a screen with nothing else on it,
   * the error needs somewhere to stay.
   */
  onError?: (message: string) => void;
}) {
  const [pending, start] = useTransition();
  return (
    <Button
      variant={variant}
      disabled={pending}
      className={className}
      onClick={() =>
        start(async () => {
          // The action returns {ok:false} for the failures it predicts, and
          // throws for the ones it does not - no Stripe key, a price id that
          // no longer exists, Stripe itself down. A throw inside a transition
          // is swallowed, so the button simply did nothing and said nothing.
          // That was survivable while this was one offer among many; behind
          // the trial gate it is the only control on a screen the person
          // cannot leave, so a silent failure locks them out of the product.
          try {
            const result = await createCheckoutSession("starter", interval, returnTo);
            if (!result.ok) {
              onError?.(result.error);
              toast.error(result.error);
              return;
            }
            window.location.href = result.url;
          } catch {
            const message = "Checkout could not be opened. Please try again, or contact us if it keeps happening.";
            onError?.(message);
            toast.error(message);
          }
        })
      }
    >
      {pending ? "Opening checkout…" : label}
    </Button>
  );
}
