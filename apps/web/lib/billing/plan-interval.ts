// ---------------------------------------------------------------------------
// Monthly or yearly, on the Billing page
// ---------------------------------------------------------------------------
//
// The Billing page printed `PLAN_PRICES[plan] + " /mo"` for every subscriber,
// so a yearly Managed customer read "€69 /mo" on the page whose job is to say
// what the account pays. And "current" on the plan cards was the tier alone,
// so the current tier's card only ever offered the portal: there was no way
// in the app to move the same plan from monthly to yearly or back, although
// the switch action takes an interval.
//
// No Stripe import here: the plan cards are a client component.

/** The same two values as `BillingInterval` in lib/stripe, restated so this file stays free of the SDK. */
export type BillingInterval = "month" | "year";

/** "€69 /mo", or "€690 /yr" for a yearly subscription. A sales-led tier has no period. */
export function priceForInterval(
  prices: { monthly: string; yearly: string },
  interval: BillingInterval | null,
  opts: { sales?: boolean } = {},
): string {
  if (opts.sales) return prices.monthly;
  return interval === "year" ? `${prices.yearly} /yr` : `${prices.monthly} /mo`;
}

/**
 * How one plan card relates to what is being paid for.
 *
 *   current         this tier, at the interval on screen
 *   other-interval  this tier, but billed at the other interval: the card
 *                   offers the switch to the interval on screen
 *   other           anything else
 *
 * When the interval being paid could not be read (null), the tier alone
 * decides, as it did before the interval was known.
 */
export type CardRelation = "current" | "other-interval" | "other";

export function planCardRelation(a: {
  isActive: boolean;
  currentTier: string | null;
  currentInterval: BillingInterval | null;
  tier: string;
  shownInterval: BillingInterval;
}): CardRelation {
  if (!a.isActive || a.currentTier !== a.tier) return "other";
  if (a.currentInterval === null || a.tier === "scale" || a.currentInterval === a.shownInterval) return "current";
  return "other-interval";
}
