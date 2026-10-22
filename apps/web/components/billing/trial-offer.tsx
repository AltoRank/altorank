"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Icons } from "@/components/ui";
import { StartTrialButton } from "./start-trial-button";
import { PLAN_LABELS, PLAN_PRICES, PLAN_YEARLY_PRICES, TRIAL_DAYS, type BillingInterval, type SelfServePlan } from "@/lib/stripe";
import { CANCEL_LINE, chargeLine, otherIntervalLine, otherPlanLine, reassuranceLine, trialIncludes, type TrialOfferFacts } from "@/lib/billing/trial-offer";
import { observeSeenOnce } from "@/lib/onboarding/seen-once";
import { useMediaQuery } from "@/lib/hooks/use-media-query";

/**
 * From Tailwind's lg the gate has a rail beside the article and the box opens
 * Stripe's form in place there. Below it the box opens the same sheet as the
 * sticky bar: Stripe keeps one Embedded Checkout per page, so an inline form
 * and a sheet both open would leave one of them an empty frame.
 */
export const INLINE_CHECKOUT_QUERY = "(min-width: 1024px)";

/** The sentence for a member who cannot buy: who can, and what it opens. */
export const MEMBER_CANNOT_BUY =
  "Only the account owner can start the trial. Ask them to: it opens the full article, approving and publishing, and the rest of the schedule.";


/**
 * The trial offer outside the gate (the Articles page): both hosted plans
 * (#280: the pricing page sells a trial on the Agency card too), both
 * intervals and the button. The gate has its own, fuller box below
 * (`TrialPriceBox`).
 */
export function TrialOffer({ canBuy = true, returnTo = "/dashboard", secondary, compact = false, initialPlan = "starter", onStart }: { canBuy?: boolean; returnTo?: string; secondary?: { href: string; label: string }; compact?: boolean; initialPlan?: SelfServePlan; onStart?: () => void }) {
  const [plan, setPlan] = useState<SelfServePlan>(initialPlan);
  const [interval, setInterval] = useState<BillingInterval>("month");
  const [error, setError] = useState<string | null>(null);
  // Nothing here is readable before the trial (lib/billing/trial.ts,
  // draftBodyLocked), so the sentence for a member who cannot buy says who
  // can, and what it opens.
  if (!canBuy) return <p className="text-sm text-ink-2">{MEMBER_CANNOT_BUY}</p>;
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
          {option.label} · <span className="whitespace-nowrap">{option.price} per {option.unit}</span>
        </button>)}
    </div>
    {/* The first charge is not a renewal: said as the charge it is. */}
    <p className="mb-3 text-sm">{TRIAL_DAYS} days free with a card, then {PLAN_LABELS[plan]} at {interval === "month" ? `${monthly} per month` : `${yearly} per year`}. {CANCEL_LINE}</p>
    <StartTrialButton plan={plan} interval={interval} returnTo={returnTo} onError={setError} onStart={onStart} />
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
  plan = "starter",
  onPlan,
  facts,
  fullArticle,
  returnTo = "/dashboard",
  onStart,
  onSeen,
  buttonRef,
}: {
  canBuy: boolean;
  interval: BillingInterval;
  onInterval: (next: BillingInterval) => void;
  /** Managed unless the owner switches to Agency; shared with the sticky bar like the interval. */
  plan?: SelfServePlan;
  onPlan?: (next: SelfServePlan) => void;
  facts: TrialOfferFacts;
  fullArticle: boolean;
  returnTo?: string;
  onStart?: () => void;
  /** Told once, the first time the box is actually on screen (lib/onboarding/seen-once.ts). */
  onSeen?: () => void;
  /** Wraps the button, so the gate can tell when it is on screen. */
  buttonRef?: React.Ref<HTMLDivElement>;
}) {
  const [error, setError] = useState<string | null>(null);
  const inline = useMediaQuery(INLINE_CHECKOUT_QUERY);
  const box = useRef<HTMLElement | null>(null);
  const seen = useRef(onSeen);
  useEffect(() => {
    seen.current = onSeen;
  }, [onSeen]);
  useEffect(() => (canBuy ? observeSeenOnce(box.current, () => seen.current?.()) : undefined), [canBuy]);
  if (!canBuy) return <p className="m-0 rounded-[10px] border border-line bg-panel p-5 text-[13px] leading-[1.6] text-ink-2">{MEMBER_CANNOT_BUY}</p>;
  const other: BillingInterval = interval === "month" ? "year" : "month";
  return (
    <section ref={box} aria-labelledby="trial-offer-heading" className="rounded-[10px] border border-line bg-panel p-5">
      {/* The plan's name means nothing yet to someone on their first visit,
          so the box leads with the trial and names a plan only once someone
          has switched away from the default (UX clarity audit 2026-10-18). */}
      {plan !== "starter" && <p className="m-0 mb-1 text-[11px] uppercase tracking-wide text-ink-3">{PLAN_LABELS[plan]} plan</p>}
      <h2 id="trial-offer-heading" className="m-0 text-[16px] font-semibold leading-snug text-ink">
        Start your free {TRIAL_DAYS}-day trial
      </h2>
      <ul className="m-0 mt-3 flex list-none flex-col gap-1.5 p-0" aria-label="What the trial includes">
        {trialIncludes(fullArticle, plan).map((line) => (
          <li key={line} className="flex items-start gap-2 text-[13px] leading-[1.5] text-ink-2">
            <span className="mt-[3px] shrink-0 text-ok-ink" aria-hidden>
              <Icons.check size={12} />
            </span>
            {line}
          </li>
        ))}
      </ul>
      <p className="m-0 mt-4 text-[14px] font-medium leading-[1.5] text-ink" data-testid="trial-charge-line">
        {chargeLine(interval, facts, plan)}
      </p>
      <div ref={buttonRef} className="mt-3">
        <StartTrialButton
          plan={plan}
          interval={interval}
          returnTo={returnTo}
          onError={setError}
          onStart={onStart}
          label={`Start ${TRIAL_DAYS}-day trial`}
          className="w-full justify-center py-2.5 text-[14px]"
          // From lg the form opens in place of the button, in the rail
          // beside the article; below lg in the sheet, like the bar's.
          embed={inline ? "inline" : "sheet"}
        />
      </div>
      <p className="m-0 mt-2.5 text-[12.5px] leading-[1.55] text-ink-2">{reassuranceLine()}</p>
      {/* Yearly and Agency are two more decisions; one quiet "Other plans"
          holds both, open once either has been picked. */}
      <details className="mt-2" open={interval !== "month" || plan !== "starter" || undefined}>
        <summary className="cursor-pointer list-none text-[12.5px] text-ink-3 underline decoration-line underline-offset-[3px] hover:text-ink-2 [&::-webkit-details-marker]:hidden">
          Other plans
        </summary>
        <button
          type="button"
          onClick={() => {
            onInterval(other);
            setError(null);
          }}
          className="mt-2 block text-left text-[12.5px] text-ink-3 underline decoration-line underline-offset-[3px] hover:text-ink-2"
        >
          {otherIntervalLine(interval, plan)}
        </button>
        {onPlan && (
          <button
            type="button"
            onClick={() => {
              onPlan(plan === "starter" ? "growth" : "starter");
              setError(null);
            }}
            className="mt-1 block text-left text-[12.5px] text-ink-3 underline decoration-line underline-offset-[3px] hover:text-ink-2"
          >
            {otherPlanLine(plan, interval)}
          </button>
        )}
      </details>
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
