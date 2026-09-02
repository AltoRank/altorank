"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button, Icons } from "@/components/ui";
import { cn } from "@/lib/utils";
import { createCheckoutSession, createBillingPortalSession } from "@/app/actions/billing";

/**
 * The ladder, on the page where you buy it.
 *
 * What this replaces was two buttons reading "Managed, €69/mo" and "Agency,
 * €199/mo" with no statement of what either included. The one screen where a
 * buyer decides between rungs was the only place in the product that would not
 * tell them what the rungs were, so the decision had to be made on the
 * marketing site and carried back here from memory.
 *
 * Plan data is passed in from the server rather than imported: @/lib/stripe
 * pulls in the Stripe SDK, which must not reach the client bundle.
 */

type SelfServePlan = "starter" | "growth";
type BillingInterval = "month" | "year";

export type PlanCard = {
  tier: "starter" | "growth" | "scale";
  label: string;
  monthly: string;
  yearly: string;
  tagline: string;
  features: string[];
};

export function PlanCards({
  plans,
  currentTier,
  isActive,
  hasCustomer,
  returnTo,
}: {
  plans: PlanCard[];
  /** The tier actually being paid for, or null when nothing is. */
  currentTier: "starter" | "growth" | "scale" | null;
  isActive: boolean;
  hasCustomer: boolean;
  /**
   * Where to send the buyer back to after checkout, when they arrived here
   * from somewhere that needed a plan. Threaded through rather than dropped:
   * without it an upgrade prompted from, say, the article editor returns the
   * user to billing and makes them find their way back.
   */
  returnTo?: string;
}) {
  const [pending, start] = useTransition();
  const [interval, setInterval] = useState<BillingInterval>("month");

  function subscribe(plan: SelfServePlan) {
    start(async () => {
      try {
        window.location.href = await createCheckoutSession(plan, interval, returnTo);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Checkout failed");
      }
    });
  }

  function portal(flow: "manage" | "cancel" | "payment_method") {
    start(async () => {
      try {
        window.location.href = await createBillingPortalSession(flow);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not open billing portal");
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-[12.5px] text-ink-3">
          Billing is per account, not per workspace — one plan covers every site
          in this workspace list.
        </div>
        <div className="flex self-start rounded-[7px] border border-line p-0.5 text-[12px]">
          {(["month", "year"] as const).map((iv) => (
            <button
              key={iv}
              onClick={() => setInterval(iv)}
              className={cn(
                "cursor-pointer rounded-[5px] px-2.5 py-1",
                interval === iv ? "bg-ink text-bg" : "text-ink-3 hover:text-ink",
              )}
            >
              {iv === "month" ? "Monthly" : "Yearly, 2 months free"}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {plans.map((p) => {
          // "Current" means paid for, not merely stored: `plan` defaults to
          // starter on an empty row, and presenting that default as a purchase
          // is the bug this page already had once.
          const current = isActive && currentTier === p.tier;
          const price = interval === "month" ? p.monthly : p.yearly;
          const sales = p.tier === "scale";

          return (
            <div
              key={p.tier}
              className={cn(
                "flex flex-col rounded-lg border bg-bg p-[18px]",
                current ? "border-accent ring-1 ring-accent" : "border-line",
              )}
            >
              <div className="flex items-center gap-2">
                <h3 className="m-0 text-sm font-semibold tracking-[-0.005em]">{p.label}</h3>
                {current && (
                  <span className="rounded-full bg-accent px-2 py-0.5 text-[10.5px] font-medium text-bg">
                    Your plan
                  </span>
                )}
              </div>

              <div className="mt-2 flex items-baseline gap-1.5">
                <span className="font-mono text-[22px] font-semibold tracking-[-0.02em]">
                  {price}
                </span>
                {!sales && (
                  <span className="text-[12px] text-ink-3">
                    {interval === "month" ? "/mo" : "/yr"}
                  </span>
                )}
              </div>

              <p className="m-0 mt-2 text-[12.5px] leading-relaxed text-ink-2">{p.tagline}</p>

              <ul className="m-0 mt-3.5 flex list-none flex-col gap-1.5 p-0">
                {p.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-[12.5px] leading-relaxed text-ink-2">
                    <Icons.check size={13} className="mt-[3px] shrink-0 text-accent-ink" />
                    {f}
                  </li>
                ))}
              </ul>

              {/* Pushed to the bottom so the buttons line up across cards whose
                  feature lists are different lengths. */}
              <div className="mt-auto pt-4">
                {current ? (
                  <div className="flex flex-col gap-2">
                    <Button onClick={() => portal("manage")} disabled={pending} className="w-full justify-center">
                      {pending ? "Opening…" : "Invoices and billing"}
                    </Button>
                    <div className="flex gap-2">
                      <Button onClick={() => portal("payment_method")} disabled={pending} className="flex-1 justify-center">
                        Update card
                      </Button>
                      <Button onClick={() => portal("cancel")} disabled={pending} className="flex-1 justify-center">
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : sales ? (
                  <a href="mailto:hello@altorank.co?subject=AltoRank%20Custom%20plan" className="block">
                    <Button className="w-full justify-center">Talk to us</Button>
                  </a>
                ) : (
                  <Button
                    variant={currentTier === null || !isActive ? "accent" : undefined}
                    onClick={() => subscribe(p.tier as SelfServePlan)}
                    disabled={pending}
                    className="w-full justify-center"
                  >
                    {isActive ? `Switch to ${p.label}` : `Choose ${p.label}`}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="m-0 max-w-[76ch] text-[12px] leading-relaxed text-ink-3">
        {hasCustomer ? (
          <>
            Cancelling takes one confirmation and ends the plan at the period
            end. Your workspaces, articles and history stay readable afterwards.
          </>
        ) : (
          <>
            No trial. Nothing is charged until you choose a plan here, and you
            can cancel it yourself from this page.
          </>
        )}{" "}
        Every feature is also in the open-source build — the paid rungs cover
        hosting, model and data costs, volume and support, not unlocks.
      </p>
    </div>
  );
}
