import Stripe from "stripe";

/**
 * Stripe client + plan config.
 *
 * Self-serve plans map to Stripe price IDs set in env; 'scale' is sales-led
 * (no self-serve checkout). Env used:
 *   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_STARTER, STRIPE_PRICE_GROWTH
 * (apiVersion is intentionally omitted so the account's pinned version is used.)
 *
 * Constructed lazily on purpose. `new Stripe("")` throws "Neither apiKey nor
 * config.authenticator provided" at module load, which meant `next build` could
 * not collect page data for the webhook route without a Stripe key. That made
 * the whole app unbuildable for a self-hoster who has no billing at all, and it
 * breaks the pivot plan's rule: never throw on a missing optional key at import
 * time. Failing on first *call* is the correct shape.
 */
let client: Stripe | null = null;

export function getStripe(): Stripe {
  if (!client) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error(
        "STRIPE_SECRET_KEY is not set. Billing is disabled in this deployment; " +
          "the rest of the app runs without it.",
      );
    }
    client = new Stripe(key);
  }
  return client;
}

/** True when billing is configured, so callers can hide it rather than crash. */
export const billingEnabled = Boolean(process.env.STRIPE_SECRET_KEY);

export type PlanTier = "starter" | "growth" | "scale";
export type SelfServePlan = "starter" | "growth";

// price id -> plan, for the webhook to resolve which tier a subscription is on.
export const PLAN_PRICE_IDS: Record<SelfServePlan, string | undefined> = {
  starter: process.env.STRIPE_PRICE_STARTER,
  growth: process.env.STRIPE_PRICE_GROWTH,
};

// The `starter`/`growth` keys are persisted on subscriptions, so they stay as
// they are; renaming them would need a migration. Only the display labels track
// the ladder, which converged on 2026-08-15: Solo became Managed.
export const PLAN_LABELS: Record<PlanTier, string> = {
  starter: "Managed",
  growth: "Agency",
  scale: "Custom",
};

export const PLAN_PRICES: Record<PlanTier, string> = {
  starter: "€99",
  growth: "€199",
  scale: "Let's talk",
};
