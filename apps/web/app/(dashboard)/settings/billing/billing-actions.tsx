"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui";
import { createCheckoutSession, createBillingPortalSession } from "@/app/actions/billing";

// Inline literal (not imported from @/lib/stripe) so the server-only Stripe SDK
// never gets pulled into the client bundle.
type SelfServePlan = "starter" | "growth";

export function BillingActions({ hasCustomer }: { hasCustomer: boolean }) {
  const [pending, start] = useTransition();

  function subscribe(plan: SelfServePlan) {
    start(async () => {
      try {
        const url = await createCheckoutSession(plan);
        window.location.href = url;
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Checkout failed");
      }
    });
  }

  function manage() {
    start(async () => {
      try {
        const url = await createBillingPortalSession();
        window.location.href = url;
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not open billing portal");
      }
    });
  }

  if (hasCustomer) {
    return (
      <Button onClick={manage} disabled={pending}>
        {pending ? "Opening…" : "Manage billing"}
      </Button>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button onClick={() => subscribe("starter")} disabled={pending}>
        Subscribe — Solo €99/mo
      </Button>
      <Button variant="accent" onClick={() => subscribe("growth")} disabled={pending}>
        Subscribe — Agency €199/mo
      </Button>
    </div>
  );
}
