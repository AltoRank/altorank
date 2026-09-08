// ---------------------------------------------------------------------------
// The ladder, as a buyer reads it - importable from a client component
// ---------------------------------------------------------------------------
//
// These constants used to live in lib/stripe.ts, which constructs the Stripe
// SDK and therefore must never reach the browser bundle. So every control that
// asked someone to pay - the editor's paywall, the pace popover, the "write
// more" button - either hardcoded a figure or, more often, quoted none at all.
// PLAN_PRICES was imported in exactly one file, the Billing page, which is the
// screen you reach *after* you have already decided.
//
// A price you only see after the click is not a price. This module is the same
// data with no SDK behind it, so the number in the CTA and the number on the
// checkout button come from one place. lib/stripe.ts re-exports it, so server
// callers can keep importing from where they always did.

export type PlanTier = "starter" | "growth" | "scale";
export type SelfServePlan = "starter" | "growth";

// The `starter`/`growth` keys are persisted on subscriptions, so they stay as
// they are; renaming them would need a migration. Only the display labels track
// the ladder, which converged on 2026-08-15: Solo became Managed.
export const PLAN_LABELS: Record<PlanTier, string> = {
  starter: "Managed",
  growth: "Agency",
  scale: "Custom",
};

export const PLAN_PRICES: Record<PlanTier, string> = {
  starter: "€69",
  growth: "€199",
  scale: "Let's talk",
};

/**
 * Yearly price, as displayed. Ten months for twelve - the same "2 months free"
 * deal the pricing page states, not a percentage, because the discount should
 * be quoted in the unit the buyer thinks in.
 */
export const PLAN_YEARLY_PRICES: Record<PlanTier, string> = {
  starter: "€690",
  growth: "€1,990",
  scale: "Let's talk",
};

/**
 * Included articles per calendar month, by tier. Restates the pricing page's
 * feature list (src/data/pricing.ts in AltoRank/altorank-marketing) - change
 * them together; nothing across the two repositories enforces it.
 * `scale` is sales-led: null means no metered ceiling here.
 */
export const PLAN_ARTICLE_LIMITS: Record<PlanTier, number | null> = {
  starter: 100,
  growth: 400,
  scale: null,
};

/** The cheapest rung anyone can buy without talking to us. */
export const ENTRY_PLAN: SelfServePlan = "starter";

/**
 * "€69/mo" for one named tier. Every CTA that asks for money quotes a tier
 * through here rather than typing the figure, so the ladder moves in one edit.
 */
export function planMonthlyPrice(tier: PlanTier): string {
  return tier === "scale" ? PLAN_PRICES.scale : `${PLAN_PRICES[tier]}/mo`;
}

/**
 * "from €69/mo" - the entry rung, for a control that asks for a plan without
 * yet knowing which one. There is no trial to mention: nothing is charged
 * until a tier is chosen on the Billing page, and that sentence belongs beside
 * the price rather than inside it.
 */
export function fromEntryPrice(): string {
  return `from ${planMonthlyPrice(ENTRY_PLAN)}`;
}

/**
 * The cheapest tier whose included volume covers `monthly`; "scale" when none
 * does. Lives here rather than beside the pace list because two controls need
 * it - the calendar's pace rows and the workspace pace slider - and both must
 * quote the same price for the same number.
 */
export function planNeededFor(monthly: number): PlanTier {
  for (const tier of ["starter", "growth"] as const) {
    const limit = PLAN_ARTICLE_LIMITS[tier];
    if (limit === null || monthly <= limit) return tier;
  }
  return "scale";
}
