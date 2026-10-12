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
//   what it includes     PLAN_ARTICLE_LIMITS and the publish gate
//                        (lib/publishing/core.ts refuses anything without an
//                        approval; auto-approve is off unless the owner turns it
//                        on, migration 079)
//
// Pure and client-safe: the gate renders it, the tests read it.

import { PLAN_ARTICLE_LIMITS, PLAN_LABELS, PLAN_PRICES, PLAN_YEARLY_PRICES, TRIAL_DAYS, type BillingInterval } from "@/lib/stripe";
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
export function yearlySaving(): number {
  return euros(PLAN_PRICES.starter) * 12 - euros(PLAN_YEARLY_PRICES.starter);
}

/** "€69/month" or "€690/year". */
export function priceLabel(interval: BillingInterval): string {
  return interval === "month" ? `${PLAN_PRICES.starter}/month` : `${PLAN_YEARLY_PRICES.starter}/year`;
}

/** The plan the trial is of, by name: Managed. */
export const TRIAL_PLAN = PLAN_LABELS.starter;

/**
 * What the trial includes, in the buyer's words. `fullArticle`: the owner has
 * read the article already, so the trial is for editing, approving and
 * publishing it; otherwise it is also what opens the text.
 */
export function trialIncludes(fullArticle: boolean): string[] {
  return [
    // How publishing works today: no CMS has a self-serve Connect button
    // (lib/cms/connectable.ts), so it is a copy, or a connection we set up on
    // request (review, 2026-10-12).
    fullArticle
      ? "Edit and approve this article, then copy it to your site or ask us to connect your site"
      : "Read this article in full, approve it, then copy it to your site or ask us to connect your site",
    `Up to ${PLAN_ARTICLE_LIMITS.starter} articles a month, written at the pace you set`,
    "Nothing publishes until you approve it",
    "No extra costs: the writing and the research are included",
  ];
}

/** "€0 today, then €69/month from October 19." The first charge, said as one. */
export function chargeLine(interval: BillingInterval, facts: TrialOfferFacts): string {
  return `€0 today, then ${priceLabel(interval)} from ${formatTrialDate(facts.endsAt)}${facts.taxAdded ? ", plus VAT where it applies" : ""}.`;
}

/** The reminder and the way out, both true in code (see the header). */
export function reassuranceLine(): string {
  return `We email you 3 days before the trial ends. Cancel any time before then from Settings, Billing, and nothing is charged.`;
}

/** The quiet second option: yearly, with its real saving; or the way back to monthly. */
export function otherIntervalLine(interval: BillingInterval): string {
  return interval === "month"
    ? `Or pay yearly: ${priceLabel("year")}, two months free (save €${yearlySaving()})`
    : `Switch back to monthly: ${priceLabel("month")}`;
}

/** The sticky bar's sentence: the same price as the box, for the same button. */
export function stickyOfferLine(interval: BillingInterval): string {
  return `${TRIAL_DAYS} days free, then ${priceLabel(interval)}. Cancel any time.`;
}
