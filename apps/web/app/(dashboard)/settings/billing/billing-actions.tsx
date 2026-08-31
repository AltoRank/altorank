"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui";
import { createCheckoutSession, createBillingPortalSession } from "@/app/actions/billing";

// Inline literals (not imported from @/lib/stripe) so the server-only Stripe
// SDK never gets pulled into the client bundle.
type SelfServePlan = "starter" | "growth";
type BillingInterval = "month" | "year";

export function BillingActions({ hasCustomer }: { hasCustomer: boolean }) {
  const [pending, start] = useTransition();
  const [interval, setInterval] = useState<BillingInterval>("month");

  function subscribe(plan: SelfServePlan) {
    start(async () => {
      try {
        const url = await createCheckoutSession(plan, interval);
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

  // The buttons said "Solo €99/mo": a plan name retired on 2026-08-15 at a
  // price retired on 2026-08-30, on the one screen where a wrong number
  // becomes a chargeback. Prices below match the live Stripe prices created
  // 2026-08-30; the yearly figures are the same two-months-free deal the
  // pricing page states.
  const label =
    interval === "month"
      ? { starter: "Managed, €69/mo", growth: "Agency, €199/mo" }
      : { starter: "Managed, €690/yr", growth: "Agency, €1,990/yr" };

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex rounded-[7px] border border-line p-0.5 text-[12px]">
        {(["month", "year"] as const).map((iv) => (
          <button
            key={iv}
            onClick={() => setInterval(iv)}
            className={`px-2.5 py-1 rounded-[5px] cursor-pointer ${
              interval === iv ? "bg-ink text-bg" : "text-ink-3 hover:text-ink"
            }`}
          >
            {iv === "month" ? "Monthly" : "Yearly, 2 months free"}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => subscribe("starter")} disabled={pending}>
          {label.starter}
        </Button>
        <Button variant="accent" onClick={() => subscribe("growth")} disabled={pending}>
          {label.growth}
        </Button>
      </div>
    </div>
  );
}
