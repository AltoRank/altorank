"use client";
import Link from "next/link";
import { useState } from "react";
import { StartTrialButton } from "./start-trial-button";
import { PLAN_PRICES, PLAN_YEARLY_PRICES, type BillingInterval } from "@/lib/stripe";

export function TrialOffer({ canBuy = true, returnTo = "/dashboard", secondary, compact = false }: { canBuy?: boolean; returnTo?: string; secondary?: { href: string; label: string }; compact?: boolean }) {
  const [interval, setInterval] = useState<BillingInterval>("month");
  const [error, setError] = useState<string | null>(null);
  if (!canBuy) return <p className="text-sm text-ink-2">You can read the draft below. Ask your account owner to start the trial to approve, publish and continue the schedule.</p>;
  return <div className={`rounded-lg border border-line bg-panel ${compact ? "p-3" : "p-4"}`}>
    <div className="mb-3 grid grid-cols-2 gap-2">
      {([{id:"month",label:"Monthly",price:PLAN_PRICES.starter,unit:"month"},{id:"year",label:"Yearly",price:PLAN_YEARLY_PRICES.starter,unit:"year"}] as const).map((option) =>
        <button key={option.id} type="button" aria-pressed={interval === option.id} onClick={() => { setInterval(option.id); setError(null); }} className={`rounded-lg border p-3 text-left ${interval === option.id ? "border-accent bg-accent/10" : "border-line"}`}>
          {option.label} · {option.price} per {option.unit}
        </button>)}
    </div>
    <p className="mb-3 text-sm">7 days free with a card, then {interval === "month" ? `${PLAN_PRICES.starter} per month` : `${PLAN_YEARLY_PRICES.starter} per year`}, plus applicable tax. Cancel from Billing before the trial ends to avoid the renewal charge.</p>
    <StartTrialButton interval={interval} returnTo={returnTo} onError={setError} />
    {secondary && <Link className="ml-4 text-accent underline" href={secondary.href}>{secondary.label}</Link>}
    {error && <p role="alert" className="mt-2 text-sm text-err-ink">{error} <Link className="underline" href="/checkout/cancelled">Manage open checkout</Link></p>}
  </div>;
}
