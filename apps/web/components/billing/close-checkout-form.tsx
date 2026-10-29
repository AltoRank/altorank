"use client";

import { useActionState } from "react";
import Link from "next/link";
import { cancelPendingCheckout, type CancelCheckoutState } from "@/app/actions/cancel-checkout";
import { Button } from "@/components/ui";

/**
 * The cancel page's one control for an owner: closes the account's open
 * checkout, then goes to `next` (app/actions/cancel-checkout.ts). When it
 * cannot, the reason stays under the control instead of an error page - and,
 * given `leave`, a plain link to `next` beside it, so a checkout that will not
 * close (Stripe down, a row that will not clear) never keeps the owner from
 * their article. The open attempt is left for the reaper.
 */
export function CloseCheckoutForm({ next, label, look = "button", leave }: { next: string; label: string; look?: "button" | "link"; leave?: string }) {
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
      {state?.error && leave && (
        <Link href={next} className="mt-2 inline-block text-sm text-accent underline">
          {leave}
        </Link>
      )}
    </form>
  );
}
