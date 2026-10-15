"use client";
import Link from "next/link";
import { useState } from "react";
import { StartTrialButton } from "./start-trial-button";
import { PLAN_LABELS, PLAN_PRICES, PLAN_YEARLY_PRICES, type BillingInterval, type SelfServePlan } from "@/lib/stripe";

/**
 * The card ask. Both hosted plans and both intervals: the pricing page sells
 * "7-day free trial, then €199" on the Agency card, and this screen used to
 * open only Managed, with Agency "a click away on Billing" - a page a gated
 * account is redirected away from.
 */
export function TrialOffer({ canBuy = true, returnTo = "/dashboard", secondary, compact = false, initialPlan = "starter", onStart }: { canBuy?: boolean; returnTo?: string; secondary?: { href: string; label: string }; compact?: boolean; initialPlan?: SelfServePlan; onStart?: () => void }) {
  const [plan, setPlan] = useState<SelfServePlan>(initialPlan);
  const [interval, setInterval] = useState<BillingInterval>("month");
  const [error, setError] = useState<string | null>(null);
  // Nothing here is readable before the trial (lib/billing/trial.ts,
  // draftBodyLocked), so the sentence for a member who cannot buy says who
  // can, and what it opens.
  if (!canBuy) return <p className="text-sm text-ink-2">Only the account owner can start the trial. Ask them to: it opens the full article, approving and publishing, and the rest of the schedule.</p>;
  const monthly = PLAN_PRICES[plan];
  const yearly = PLAN_YEARLY_PRICES[plan];
  return <div className={`rounded-lg border border-line bg-panel ${compact ? "p-3" : "p-4"}`}>
    <div className="mb-2 grid grid-cols-2 gap-2">
      {(["starter", "growth"] as const).map((tier) =>
        <button key={tier} type="button" aria-pressed={plan === tier} onClick={() => { setPlan(tier); setError(null); }} className={`rounded-lg border p-3 text-left ${plan === tier ? "border-accent bg-accent/10" : "border-line"}`}>
          {PLAN_LABELS[tier]}
        </button>)}
    </div>
    <div className="mb-3 grid grid-cols-2 gap-2">
      {([{id:"month",label:"Monthly",price:monthly,unit:"month"},{id:"year",label:"Yearly",price:yearly,unit:"year"}] as const).map((option) =>
        <button key={option.id} type="button" aria-pressed={interval === option.id} onClick={() => { setInterval(option.id); setError(null); }} className={`rounded-lg border p-3 text-left ${interval === option.id ? "border-accent bg-accent/10" : "border-line"}`}>
          {option.label} · {option.price} per {option.unit}
        </button>)}
    </div>
    <p className="mb-3 text-sm">7 days free with a card, then {PLAN_LABELS[plan]} at {interval === "month" ? `${monthly} per month` : `${yearly} per year`}, plus applicable tax. Cancel from Billing before the trial ends to avoid the renewal charge.</p>
    <StartTrialButton plan={plan} interval={interval} returnTo={returnTo} onError={setError} onStart={onStart} />
    {secondary && <Link className="ml-4 text-accent underline" href={secondary.href}>{secondary.label}</Link>}
    {error && <p role="alert" className="mt-2 text-sm text-err-ink">{error} <Link className="underline" href="/checkout/cancelled">Manage open checkout</Link></p>}
  </div>;
}
