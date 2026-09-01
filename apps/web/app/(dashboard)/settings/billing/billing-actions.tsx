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

  function portal(flow: "manage" | "cancel" | "payment_method") {
    start(async () => {
      try {
        const url = await createBillingPortalSession(flow);
        window.location.href = url;
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not open billing portal");
      }
    });
  }

  if (hasCustomer) {
    // Three buttons, not one. "Manage billing" alone hides the two actions
    // people actually come here for, and hiding them is the complaint that
    // fills our competitors' review pages. Cancel lands on the confirmation
    // screen; nothing else is required and nothing in the workspace is lost.
    return (
      <div className="flex flex-col items-end gap-2">
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={() => portal("payment_method")} disabled={pending}>
            Update card
          </Button>
          <Button onClick={() => portal("cancel")} disabled={pending}>
            Cancel subscription
          </Button>
          <Button variant="accent" onClick={() => portal("manage")} disabled={pending}>
            {pending ? "Opening…" : "Invoices and billing"}
          </Button>
        </div>
        <p className="max-w-[46ch] text-right text-[11.5px] leading-relaxed text-ink-3">
          Cancelling takes one confirmation and ends the plan at the period end. Your
          workspaces, articles and history stay readable afterwards.
        </p>
      </div>
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
      <p className="max-w-[46ch] text-right text-[11.5px] leading-relaxed text-ink-3">
        No trial. Nothing is charged until you choose a plan here, and you can cancel it
        yourself from this page.
      </p>
    </div>
  );
}
