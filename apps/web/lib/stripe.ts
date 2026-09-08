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

/**
 * Whether Checkout asks Stripe to compute and add VAT.
 *
 * Off by default, and off is load-bearing: `automatic_tax: { enabled: true }`
 * is rejected by Stripe unless Stripe Tax is activated on the account with a
 * head-office address and the Prices carry a tax code - so with it on and the
 * account not set up, `checkout.sessions.create` throws and nobody can pay.
 * That was the state on 2026-09-06 for a few hours.
 *
 * SUPALABS registered for Italian VAT on 2026-09-06 (domestic only, having
 * elected the EU micro-business threshold, so EU consumers are charged the
 * Italian rate). The flag stays off until the account finishes the two settings
 * that make automatic_tax safe: a preset product category, and "Include tax in
 * prices" = No. The default there is Automatic, which treats every non-USD/CAD
 * price as tax-INCLUSIVE - on euro prices that quietly carves the VAT out of
 * revenue instead of adding it. docs/deploy.md, "Stripe", has the order.
 */
export const stripeTaxEnabled = process.env.STRIPE_TAX_ENABLED === "true";

/**
 * The ladder itself - tiers, labels and prices - lives in
 * lib/billing/plan-prices.ts, which has no Stripe SDK behind it and can
 * therefore be imported by a button. Re-exported here so every existing server
 * caller keeps its import path.
 */
export {
  PLAN_ARTICLE_LIMITS,
  PLAN_LABELS,
  PLAN_PRICES,
  PLAN_YEARLY_PRICES,
  ENTRY_PLAN,
  planMonthlyPrice,
  fromEntryPrice,
} from "@/lib/billing/plan-prices";
export type { PlanTier, SelfServePlan } from "@/lib/billing/plan-prices";
import type { PlanTier, SelfServePlan } from "@/lib/billing/plan-prices";

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
 * Which tier a Stripe price id sells, or undefined for one we do not recognise.
 *
 * The inverse of PLAN_PRICE_IDS and the only trustworthy answer to "what did
 * this customer buy": the price on the subscription is what Stripe charges,
 * whereas anything in metadata is a hint we wrote earlier and could have got
 * wrong. The webhook resolves the tier through here before it writes
 * `agencies.plan`, because that column drives PLAN_ARTICLE_LIMITS - getting it
 * wrong meters an Agency customer at Managed's 100 (2026-09-06).
 *
 * Env is read on every call rather than captured at import so a price id
 * rotated in the environment takes effect on the next event, and so tests can
 * set the four variables they need.
 */
export function planForPriceId(priceId: string | null | undefined): SelfServePlan | undefined {
  if (!priceId) return undefined;
  if (
    priceId === process.env.STRIPE_PRICE_STARTER ||
    priceId === process.env.STRIPE_PRICE_STARTER_YEARLY
  )
    return "starter";
  if (
    priceId === process.env.STRIPE_PRICE_GROWTH ||
    priceId === process.env.STRIPE_PRICE_GROWTH_YEARLY
  )
    return "growth";
  return undefined;
}

/** True when `plan` is a tier we sell self-serve, for narrowing untrusted strings. */
export function isSelfServePlan(plan: unknown): plan is SelfServePlan {
  return plan === "starter" || plan === "growth";
}

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
 * src/data/pricing.ts in AltoRank/altorank-marketing, for the same reason
 * PLAN_ARTICLE_LIMITS and PLAN_PRICES are: they are separate repositories and
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
    "100 articles / month included, at the pace you set per site",
    "Articles publish without the AltoRank line",
    "Up to 3 workspaces (sites or clients)",
    "€0.60 per additional article",
    "No API keys needed, costs included",
    "Voice profile training",
    "Keyword research + rank tracking",
    "All 10 CMS integrations",
    "Email support",
  ],
  growth: [
    "Everything in Managed",
    "400 articles / month included, at the pace you set per site",
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

/**
 * Every event the webhook at /api/webhooks/stripe needs the Stripe endpoint to
 * be subscribed to. The endpoint's event list is dashboard configuration that
 * nothing in this repository can set, so this is the checklist - and a test
 * asserts the route handles each one, so the list cannot drift from the code.
 *
 * What breaks when one is missing:
 *   checkout.session.completed      plan_status never goes active after checkout
 *   customer.subscription.created   a subscription started outside our checkout
 *                                   is never mapped to an agency
 *   customer.subscription.updated   plan changes, cancel-at-period-end and the
 *                                   period end are never recorded
 *   customer.subscription.deleted   cancellations never land; access never ends
 *   invoice.payment_failed          the past-due grace window and dunning banner
 *                                   never start (migration 071)
 *   invoice.paid                    a recovered payment never clears them
 */
export const REQUIRED_STRIPE_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
  "invoice.paid",
] as const;
