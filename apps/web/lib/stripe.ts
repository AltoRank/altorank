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

export type BillingInterval = "month" | "year";

// price id per plan and interval, for checkout and for the webhook to resolve
// which tier a subscription is on. Yearly is two months free, the same deal
// pricing.ts states on the marketing site.
export const PLAN_PRICE_IDS: Record<
  SelfServePlan,
  Record<BillingInterval, string | undefined>
> = {
  starter: {
    month: process.env.STRIPE_PRICE_STARTER,
    year: process.env.STRIPE_PRICE_STARTER_YEARLY,
  },
  growth: {
    month: process.env.STRIPE_PRICE_GROWTH,
    year: process.env.STRIPE_PRICE_GROWTH_YEARLY,
  },
};

/**
 * Included articles per calendar month, by tier. Restates the pricing page's
 * feature list (apps/marketing/src/data/pricing.ts) - change them together.
 * `scale` is sales-led: null means no metered ceiling here.
 */
export const PLAN_ARTICLE_LIMITS: Record<PlanTier, number | null> = {
  starter: 100,
  growth: 400,
  scale: null,
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

/** One line on who each rung is for. Mirrors `desc` in the pricing data. */
export const PLAN_TAGLINES: Record<PlanTier, string> = {
  starter:
    "No API keys to manage, because model and data costs are included. For solo operators and agencies running one or two brands.",
  growth:
    "For agencies running content across a full client roster. Everything metered on output, not seats or workspaces.",
  scale:
    "Volume beyond the Agency tier, or terms your procurement team needs in writing.",
};

/**
 * What each rung includes, in the buyer's words.
 *
 * A deliberate second copy of the `features` arrays in
 * apps/marketing/src/data/pricing.ts, for the same reason PLAN_ARTICLE_LIMITS
 * and PLAN_PRICES are: apps/web and apps/marketing are separate workspaces and
 * neither can import the other. Change them together. The billing page is the
 * screen where a wrong figure becomes a chargeback, so it quotes the ladder
 * rather than paraphrasing it.
 *
 * Nothing here is a capability the free self-host tier lacks - under AGPL there
 * are no feature gates. The paid rungs sell hosting, included model and data
 * costs, volume and support: the things self-hosting makes you provide
 * yourself. Listing multi-tenant as a paid differentiator would contradict the
 * open-source promise, which is why it does not appear.
 *
 * The one line that reads like a gate and is not: "Articles publish without the
 * AltoRank line". Self-hosters have never carried that line and still do not -
 * it applies to the hosted free tier, where we are paying the model and data
 * bills for someone publishing at no cost. Buying a plan is one of two ways to
 * remove it; running your own instance is the other, and it is free
 * (2026-09-02, see lib/publishing/attribution.ts).
 */
export const PLAN_FEATURES: Record<PlanTier, string[]> = {
  starter: [
    "100 articles / month included",
    "Articles publish without the AltoRank line",
    "Up to 3 workspaces (sites or clients)",
    "€0.60 per additional article",
    "No API keys needed, costs included",
    "Voice profile training",
    "Keyword research + rank tracking",
    "All 11 CMS integrations",
    "Email support",
  ],
  growth: [
    "Everything in Managed",
    "400 articles / month included",
    "Unlimited workspaces: a site or a client each",
    "€0.45 per additional article",
    "Role-based permissions for your team",
    "Priority support, same-day",
    "Onboarding call and migration help",
  ],
  scale: [
    "Everything in Agency",
    "Volume priced to your output",
    "Invoicing and procurement terms",
    "A named contact",
  ],
};
