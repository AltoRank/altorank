// ---------------------------------------------------------------------------
// What the trial offer says: what it includes, what it costs, how to stop it
// ---------------------------------------------------------------------------
//
// The price box under the first article sold nothing and frightened people
// (UX audit 2026-10-12, #6): no plan name, no list of what the trial opens,
// no "€0 today", a Monthly tile that looked more like the button than the
// button did, and "Cancel from Billing before the trial ends to avoid the
// renewal charge" - the first charge is not a renewal, and Billing is inside
// the dashboard the gate blocked.
//
// Every sentence here is checked against the code that makes it true:
//
//   the price            PLAN_PRICES / PLAN_YEARLY_PRICES (lib/stripe.ts);
//                        yearly's saving is computed from the two, not typed
//   €0 today             checkout adds TRIAL_DAYS of trial to an account that
//                        never had one (app/actions/billing.ts, trialEligible),
//                        and the gate is shown only to those accounts
//   the date             the trial ends TRIAL_DAYS after checkout
//   the reminder         Stripe's customer.subscription.trial_will_end, three
//                        days out, relayed by the webhook as the `trial_ending`
//                        email in the `billing` category, which cannot be
//                        unsubscribed from (lib/email/categories.ts)
//   cancel from where    Settings > Billing, open during a trial: a trialing
//                        account is past the gate (lib/billing/trial.ts) and
//                        the Billing page offers cancelling to any subscription
//   VAT                  added at checkout only with STRIPE_TAX_ENABLED
//   card required        checkout always takes a card (app/actions/billing.ts)
//   what it includes     PLAN_ARTICLE_LIMITS and the publish gate
//                        (lib/publishing/core.ts refuses anything without an
//                        approval; auto-approve is off unless the owner turns it
//                        on, migration 079)
//
// Pure and client-safe: the gate renders it, the tests read it.

import { PLAN_ARTICLE_LIMITS, PLAN_LABELS, PLAN_PRICES, PLAN_YEARLY_PRICES, TRIAL_DAYS, type BillingInterval, type SelfServePlan } from "@/lib/stripe";
import { formatTrialDate } from "./trial";

const DAY_MS = 24 * 60 * 60 * 1000;

/** What the server knows about the offer that the screen cannot work out alone. */
export interface TrialOfferFacts {
  /** When a trial started now would end: ISO, from the server's clock. */
  endsAt: string;
  /** Checkout adds VAT (STRIPE_TAX_ENABLED). */
  taxAdded: boolean;
}

/** The facts for a trial started at `now`. */
export function trialOfferFacts(now: Date, taxAdded: boolean): TrialOfferFacts {
  return { endsAt: new Date(now.getTime() + TRIAL_DAYS * DAY_MS).toISOString(), taxAdded };
}

/** "€69" to 69. */
function euros(price: string): number {
  return Number(price.replace(/[^\d.]/g, ""));
}

/** What a year on yearly saves against twelve months on monthly, in euros: €138 for Managed. */
export function yearlySaving(plan: SelfServePlan = "starter"): number {
  return euros(PLAN_PRICES[plan]) * 12 - euros(PLAN_YEARLY_PRICES[plan]);
}

/** "€69/month" or "€690/year" (Managed), "€199/month" or "€1,990/year" (Agency). */
export function priceLabel(interval: BillingInterval, plan: SelfServePlan = "starter"): string {
  return interval === "month" ? `${PLAN_PRICES[plan]}/month` : `${PLAN_YEARLY_PRICES[plan]}/year`;
}

/**
 * How to stop the trial, worded once and used everywhere it is said: the box,
 * the checkout sheet and the trial offer outside the gate. Three wordings
 * ("Cancel any time before then from Settings, Billing", "Cancel any time.",
 * "Cancel from Billing before the trial ends") read like three policies (UX
 * clarity audit 2026-10-18, #4).
 */
export const CANCEL_LINE = "Cancel in Settings › Billing before the trial ends and nothing is charged.";

/** The plan the gate offers first, by name: Managed. Agency is the quiet second choice. */
export const TRIAL_PLAN = PLAN_LABELS.starter;

/** The heading over the topics the trial would write next. */
export const NEXT_ARTICLES_HEADING = "Your next articles";

/** How many of them the offer names: enough to be real, few enough for a phone's first screen. */
export const NEXT_ARTICLES_SHOWN = 3;

/**
 * What the trial is for, under the topics it names. Four generic benefits
 * ("Nothing publishes until you approve it", "No extra costs") sold nothing
 * (Codex review of the gate, 2026-10-28); what owners have done with the
 * first article is copy it onto their own site, so the offer
 * names the next ones and says that. Without a topic to name, the same
 * sentence about articles for the site.
 */
export function nextArticlesLine(named: boolean): string {
  return named
    ? "Start your trial to have these written. Review each article, then copy it to your website."
    : "Start your trial to have articles written for your site. Review each article, then copy it to your website.";
}

/** The plan's terms, folded under "Plan details": true in code (see the header). */
export function planDetails(plan: SelfServePlan = "starter"): string[] {
  return [
    `Up to ${PLAN_ARTICLE_LIMITS[plan]} articles a month, written at the pace you set`,
    "Nothing publishes until you approve it",
    "Writing and topic research included",
  ];
}

/**
 * The line directly above every trial button: that a card is asked for,
 * what today costs, and the first charge with its date. The card is the
 * surprise this used to leave for Stripe's form (UX clarity audit
 * 2026-10-18; Codex review 2026-10-28: no price in the phone's first screen).
 */
export function priceLine(interval: BillingInterval, facts: TrialOfferFacts, plan: SelfServePlan = "starter"): string {
  const price = `${priceLabel(interval, plan)}${facts.taxAdded ? " (plus VAT where it applies)" : ""}`;
  return `Card required. €0 today. Then ${price} from ${formatTrialDate(facts.endsAt)} unless you cancel.`;
}

/** The reminder and the way out, both true in code (see the header). */
export function reassuranceLine(): string {
  return `We email you 3 days before the trial ends. ${CANCEL_LINE}`;
}

/** The quiet second option: yearly, with its real saving; or the way back to monthly. */
export function otherIntervalLine(interval: BillingInterval, plan: SelfServePlan = "starter"): string {
  return interval === "month"
    ? `Or pay yearly: ${priceLabel("year", plan)}, two months free (save €${yearlySaving(plan).toLocaleString("en")})`
    : `Switch back to monthly: ${priceLabel("month", plan)}`;
}

/**
 * The quiet plan switch (#280 put Agency on the trial screen: the pricing page
 * sells "7-day free trial, then €199" on the Agency card). Managed stays the
 * plan the box leads with; Agency is one line under it, for agencies.
 */
export function otherPlanLine(plan: SelfServePlan, interval: BillingInterval): string {
  return plan === "starter"
    ? `Running sites for clients? Try ${PLAN_LABELS.growth} instead: ${priceLabel(interval, "growth")}`
    : `Back to ${PLAN_LABELS.starter}: ${priceLabel(interval, "starter")}`;
}

/** The sticky bar's sentence: the same price as the box, for the same button. How to cancel is the box's to say. */
export function stickyOfferLine(interval: BillingInterval, plan: SelfServePlan = "starter"): string {
  return `${TRIAL_DAYS} days free, then ${priceLabel(interval, plan)}.`;
}
