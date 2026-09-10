"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui";
import { createCheckoutSession } from "@/app/actions/billing";

/**
 * The one button that opens the trial's checkout: Managed, monthly, card
 * required, seven days before the first charge. Everywhere the trial is
 * offered renders this so the offer and the checkout it opens cannot drift.
 * Yearly and Agency are a click away on Billing, where the ladder is.
 */
export function StartTrialButton({
  returnTo,
  label = "Start 7-day trial",
  variant = "accent",
  className,
}: {
  /** Same-origin path to land on after the card is taken. */
  returnTo?: string;
  label?: string;
  variant?: "accent" | undefined;
  className?: string;
}) {
  const [pending, start] = useTransition();
  return (
    <Button
      variant={variant}
      disabled={pending}
      className={className}
      onClick={() =>
        start(async () => {
          const result = await createCheckoutSession("starter", "month", returnTo);
          if (!result.ok) {
            toast.error(result.error);
            return;
          }
          window.location.href = result.url;
        })
      }
    >
      {pending ? "Opening checkout…" : label}
    </Button>
  );
}
