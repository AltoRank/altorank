"use client";

import { useActionState } from "react";
import { cancelPendingCheckout, type CancelCheckoutState } from "@/app/actions/cancel-checkout";
import { Button } from "@/components/ui";

/**
 * The cancel page's one control for an owner: closes the account's open
 * checkout, then goes to `next` (app/actions/cancel-checkout.ts). When it
 * cannot, the reason stays under the control instead of an error page.
 */
export function CloseCheckoutForm({ next, label, look = "button" }: { next: string; label: string; look?: "button" | "link" }) {
  const [state, action, pending] = useActionState<CancelCheckoutState, FormData>(cancelPendingCheckout, null);
  return (
    <form action={action} className="mb-5">
      <input type="hidden" name="next" value={next} />
      {look === "button" ? (
        <Button type="submit" variant="accent" disabled={pending} className="h-8 py-0">
          {label}
        </Button>
      ) : (
        <button type="submit" disabled={pending} className="text-accent underline">
          {label}
        </button>
      )}
      {state?.error && (
        <p role="alert" className="mt-3 text-sm text-err-ink">
          {state.error}
        </p>
      )}
    </form>
  );
}
