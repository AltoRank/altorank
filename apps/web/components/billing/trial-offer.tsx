"use client";
import Link from "next/link";
import { useState } from "react";
import { Icons } from "@/components/ui";
import { StartTrialButton } from "./start-trial-button";
import { PLAN_PRICES, PLAN_YEARLY_PRICES, TRIAL_DAYS, type BillingInterval } from "@/lib/stripe";
import { TRIAL_PLAN, chargeLine, otherIntervalLine, reassuranceLine, trialIncludes, type TrialOfferFacts } from "@/lib/billing/trial-offer";

/** The sentence for a member who cannot buy: who can, and what it opens. */
export const MEMBER_CANNOT_BUY =
  "Only the account owner can start the trial. Ask them to: it opens the full article, approving and publishing, and the rest of the schedule.";

/**
 * The trial offer outside the gate (the Articles page): the two intervals and
 * the button. The gate has its own, fuller box below (`TrialPriceBox`).
 */
export function TrialOffer({ canBuy = true, returnTo = "/dashboard", secondary, compact = false, onStart }: { canBuy?: boolean; returnTo?: string; secondary?: { href: string; label: string }; compact?: boolean; onStart?: () => void }) {
  const [interval, setInterval] = useState<BillingInterval>("month");
  const [error, setError] = useState<string | null>(null);
  // Nothing here is readable before the trial (lib/billing/trial.ts,
  // draftBodyLocked), so the sentence for a member who cannot buy says who
  // can, and what it opens.
  if (!canBuy) return <p className="text-sm text-ink-2">{MEMBER_CANNOT_BUY}</p>;
  return <div className={`rounded-lg border border-line bg-panel ${compact ? "p-3" : "p-4"}`}>
    <div className="mb-3 grid grid-cols-2 gap-2">
      {([{id:"month",label:"Monthly",price:PLAN_PRICES.starter,unit:"month"},{id:"year",label:"Yearly",price:PLAN_YEARLY_PRICES.starter,unit:"year"}] as const).map((option) =>
        <button key={option.id} type="button" aria-pressed={interval === option.id} onClick={() => { setInterval(option.id); setError(null); }} className={`rounded-lg border p-3 text-left ${interval === option.id ? "border-accent bg-accent/10" : "border-line"}`}>
          {option.label} · <span className="whitespace-nowrap">{option.price} per {option.unit}</span>
        </button>)}
    </div>
    {/* The first charge is not a renewal: said as the charge it is. */}
    <p className="mb-3 text-sm">{TRIAL_DAYS} days free with a card, then {interval === "month" ? `${PLAN_PRICES.starter} per month` : `${PLAN_YEARLY_PRICES.starter} per year`}. Cancel from Billing before the trial ends and nothing is charged.</p>
    <StartTrialButton interval={interval} returnTo={returnTo} onError={setError} onStart={onStart} />
    {secondary && <Link className="ml-4 text-accent underline" href={secondary.href}>{secondary.label}</Link>}
    {error && <p role="alert" className="mt-2 text-sm text-err-ink">{error} <Link className="underline" href="/checkout/cancelled">Manage open checkout</Link></p>}
  </div>;
}

/**
 * The gate's price box (UX audit 2026-10-12, #6): what the trial includes,
 * "€0 today, then €69/month from <date>", the reminder and the way out, one
 * full-width button, and yearly as a quiet second option with its real
 * saving. The interval is the gate's, not this box's: the sticky bar's
 * button opens the same checkout (#9: it always opened a monthly one).
 * Every line comes from lib/billing/trial-offer.ts, where each is checked
 * against the code that makes it true.
 */
export function TrialPriceBox({
  canBuy,
  interval,
  onInterval,
  facts,
  fullArticle,
  returnTo = "/dashboard",
  onStart,
  buttonRef,
}: {
  canBuy: boolean;
  interval: BillingInterval;
  onInterval: (next: BillingInterval) => void;
  facts: TrialOfferFacts;
  fullArticle: boolean;
  returnTo?: string;
  onStart?: () => void;
  /** Wraps the button, so the gate can tell when it is on screen. */
  buttonRef?: React.Ref<HTMLDivElement>;
}) {
  const [error, setError] = useState<string | null>(null);
  if (!canBuy) return <p className="m-0 rounded-[10px] border border-line bg-panel p-5 text-[13px] leading-[1.6] text-ink-2">{MEMBER_CANNOT_BUY}</p>;
  const other: BillingInterval = interval === "month" ? "year" : "month";
  return (
    <section aria-labelledby="trial-offer-heading" className="rounded-[10px] border border-line bg-panel p-5">
      {/* The plan's name means nothing yet to someone on their first visit:
          it is a label over the heading, not the heading (review, 2026-10-12). */}
      <p className="m-0 mb-1 text-[11px] uppercase tracking-wide text-ink-3">{TRIAL_PLAN} plan</p>
      <h2 id="trial-offer-heading" className="m-0 text-[16px] font-semibold leading-snug text-ink">
        Start your free {TRIAL_DAYS}-day trial
      </h2>
      <ul className="m-0 mt-3 flex list-none flex-col gap-1.5 p-0" aria-label="What the trial includes">
        {trialIncludes(fullArticle).map((line) => (
          <li key={line} className="flex items-start gap-2 text-[13px] leading-[1.5] text-ink-2">
            <span className="mt-[3px] shrink-0 text-ok-ink" aria-hidden>
              <Icons.check size={12} />
            </span>
            {line}
          </li>
        ))}
      </ul>
      <p className="m-0 mt-4 text-[14px] font-medium leading-[1.5] text-ink" data-testid="trial-charge-line">
        {chargeLine(interval, facts)}
      </p>
      <div ref={buttonRef} className="mt-3">
        <StartTrialButton
          interval={interval}
          returnTo={returnTo}
          onError={setError}
          onStart={onStart}
          label={`Start ${TRIAL_DAYS}-day trial`}
          className="w-full justify-center py-2.5 text-[14px]"
        />
      </div>
      <p className="m-0 mt-2.5 text-[12.5px] leading-[1.55] text-ink-2">{reassuranceLine()}</p>
      <button
        type="button"
        onClick={() => {
          onInterval(other);
          setError(null);
        }}
        className="mt-2 text-left text-[12.5px] text-ink-3 underline decoration-line underline-offset-[3px] hover:text-ink-2"
      >
        {otherIntervalLine(interval)}
      </button>
      {error && (
        <p role="alert" className="m-0 mt-2 text-[12.5px] text-err-ink">
          {error}{" "}
          <Link className="underline" href="/checkout/cancelled">
            Manage open checkout
          </Link>
        </p>
      )}
    </section>
  );
}
