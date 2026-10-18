import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlanTier } from "@/lib/stripe";
import { paceOnActivation } from "@/lib/content/pace";
import { oweResume } from "@/lib/plan/resume-week";
import type { ResumeRequest } from "@/lib/plan/resume-dispatch";
import { queryShopify } from "@/lib/cms/shopify";
import { recordEvent } from "@/lib/observability/record";
import { shopAdminBase } from "./shop-domain";

/**
 * Plans for stores that installed AltoRank from the Shopify App Store.
 *
 * They pay through Shopify App Pricing: the plans live in the Partner
 * Dashboard, Shopify hosts the plan picker and charges the store, and the
 * App Store does not allow billing those merchants anywhere else. Shopify
 * sends no webhook when a subscription changes; the Partner API's
 * `activeSubscription` is the answer, read on every open of the app and in a
 * daily sweep (app/api/cron/shopify-billing).
 * https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing
 *
 * What it says is written to the columns the Stripe webhook writes, so the
 * quota, the trial gate and every entitlement check read one model.
 * `accounts.billing_provider` (migration 118) keeps the two from writing over
 * each other: a store's subscription never touches an account Stripe bills.
 *
 * Env:
 *   SHOPIFY_PARTNER_ORG_ID       the organization id in the Partner Dashboard URL
 *   SHOPIFY_PARTNER_API_TOKEN    a Partner API client token with "Manage apps"
 *   SHOPIFY_APP_GID              gid://shopify/App/<id>
 *   SHOPIFY_APP_HANDLE           the app's handle (shopify.app.toml), for the plan page URL
 *   SHOPIFY_PLAN_TIERS           plan handle → tier, e.g. "managed:starter,agency:growth"
 */

const PARTNER_API_VERSION = "2026-10";
const DEFAULT_PLAN_TIERS = "managed:starter,agency:growth";

interface PartnerConfig {
  orgId: string;
  token: string;
  appGid: string;
}

function partnerConfig(): PartnerConfig | null {
  const orgId = process.env.SHOPIFY_PARTNER_ORG_ID?.trim();
  const token = process.env.SHOPIFY_PARTNER_API_TOKEN?.trim();
  const appGid = process.env.SHOPIFY_APP_GID?.trim();
  if (!orgId || !token || !appGid) return null;
  return { orgId, token, appGid };
}

/** Shopify plan handle → our tier. Unknown handles map to nothing. */
export function planTierFor(handle: string, table = process.env.SHOPIFY_PLAN_TIERS ?? DEFAULT_PLAN_TIERS): PlanTier | null {
  for (const pair of table.split(",")) {
    const [h, tier] = pair.split(":").map((s) => s.trim());
    if (h === handle && (tier === "starter" || tier === "growth" || tier === "scale")) return tier;
  }
  return null;
}

/** The Shopify-hosted page where a store picks or changes its plan. */
export function planSelectionUrl(shop: string): string | null {
  const appHandle = process.env.SHOPIFY_APP_HANDLE?.trim() || "altorank";
  const store = shop.replace(/\.myshopify\.com$/, "");
  return `https://admin.shopify.com/store/${encodeURIComponent(store)}/charges/${encodeURIComponent(appHandle)}/pricing_plans`;
}

export interface ShopifySubscription {
  handle: string;
  trialEndsAt: string | null;
  cancelAtEndOfCycle: boolean;
  periodEnd: string | null;
}

const ACTIVE_SUBSCRIPTION = `query AltoRankActiveSubscription($appId: ID!, $shopId: ID!) {
  activeSubscription(appId: $appId, shopId: $shopId) {
    cancelAtEndOfCycle
    trialEndsAt
    currentBillingCycle { endTime }
    items { handle }
  }
}`;

/** The store's subscription, or null when it has none. Throws when the Partner API cannot be asked. */
export async function fetchActiveSubscription(shopGid: string): Promise<ShopifySubscription | null> {
  const cfg = partnerConfig();
  if (!cfg) throw new Error("Shopify billing is not configured: set SHOPIFY_PARTNER_ORG_ID, SHOPIFY_PARTNER_API_TOKEN and SHOPIFY_APP_GID.");
  const res = await fetch(`https://partners.shopify.com/${cfg.orgId}/api/${PARTNER_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": cfg.token },
    body: JSON.stringify({ query: ACTIVE_SUBSCRIPTION, variables: { appId: cfg.appGid, shopId: shopGid } }),
  });
  if (!res.ok) throw new Error(`Partner API ${res.status}`);
  const body = (await res.json()) as {
    data?: {
      activeSubscription: {
        cancelAtEndOfCycle?: boolean;
        trialEndsAt?: string | null;
        currentBillingCycle?: { endTime?: string | null } | null;
        items?: Array<{ handle?: string }>;
      } | null;
    };
    errors?: Array<{ message?: string }>;
  };
  if (body.errors?.length) throw new Error(`Partner API: ${body.errors.map((e) => e.message).join("; ")}`);
  const sub = body.data?.activeSubscription;
  if (!sub) return null;
  return {
    handle: sub.items?.find((i) => i.handle)?.handle ?? "",
    trialEndsAt: sub.trialEndsAt ?? null,
    cancelAtEndOfCycle: Boolean(sub.cancelAtEndOfCycle),
    periodEnd: sub.currentBillingCycle?.endTime ?? null,
  };
}

interface AccountBilling {
  billing_provider: string | null;
  stripe_subscription_id: string | null;
  plan_status: string | null;
}

/**
 * The account columns a subscription means, or null for "leave the account
 * alone". Pure, so the mapping is tested without a database.
 *
 *  - An account Stripe bills is never touched: a store whose owner also pays
 *    by card would otherwise have its plan rewritten by whichever ran last.
 *  - No subscription: an account Shopify was billing is canceled; one that
 *    never subscribed stays as it is (the free tier, then the plan picker).
 *  - A subscription in its trial is `trialing` with Shopify's end date, so
 *    the trial gate opens exactly as it does after a Stripe card trial.
 */
export function accountFieldsFor(
  sub: ShopifySubscription | null,
  account: AccountBilling,
  now: number = Date.now(),
): Record<string, unknown> | null {
  if (account.billing_provider !== "shopify" && account.stripe_subscription_id) return null;
  if (!sub) {
    if (account.billing_provider !== "shopify") return null;
    return { plan_status: "canceled", cancels_at: null };
  }
  const tier = planTierFor(sub.handle);
  if (!tier) return null;
  const trialing = Boolean(sub.trialEndsAt && Date.parse(sub.trialEndsAt) > now);
  return {
    billing_provider: "shopify",
    plan: tier,
    plan_status: trialing ? "trialing" : "active",
    trial_ends_at: sub.trialEndsAt,
    current_period_end: sub.periodEnd,
    cancels_at: sub.cancelAtEndOfCycle ? sub.periodEnd : null,
    payment_failed_at: null,
  };
}

const ENTITLED = new Set(["active", "trialing"]);

/** A store's GID, which the Partner API wants instead of its domain. Stored once read. */
async function shopGidFor(db: SupabaseClient, installation: { id: string; shop: string; shopGid: string | null }): Promise<string> {
  if (installation.shopGid) return installation.shopGid;
  const data = await queryShopify<{ shop: { id: string } }>(
    shopAdminBase(installation.shop),
    { installationId: installation.id },
    `query AltoRankShopId { shop { id } }`,
  );
  await db.from("shopify_installations").update({ shop_gid: data.shop.id }).eq("id", installation.id);
  return data.shop.id;
}

/**
 * Read a store's subscription and write what it means to its account.
 * Returns the work a new subscription unlocks (the held drafts), for the
 * caller to dispatch with `after()`, or null.
 */
export async function syncShopifyBilling(
  db: SupabaseClient,
  installation: { id: string; shop: string; accountId: string; shopGid: string | null },
): Promise<{ resume: ResumeRequest | null; planHandle: string | null }> {
  const shopGid = await shopGidFor(db, installation);
  const sub = await fetchActiveSubscription(shopGid);

  const { data: account, error } = await db
    .from("accounts")
    .select("billing_provider, stripe_subscription_id, plan_status")
    .eq("id", installation.accountId)
    .single();
  if (error || !account) throw new Error(`Could not read the account: ${error?.message ?? "missing"}`);

  await db
    .from("shopify_installations")
    .update({ plan_handle: sub?.handle ?? null, plan_checked_at: new Date().toISOString() })
    .eq("id", installation.id);

  const fields = accountFieldsFor(sub, account as AccountBilling);
  if (sub && !planTierFor(sub.handle)) {
    await recordEvent(
      { level: "error", source: "shopify.billing", message: `Unknown Shopify plan handle "${sub.handle}"; set SHOPIFY_PLAN_TIERS`, accountId: installation.accountId, context: { shop: installation.shop } },
      db,
    );
  }
  if (!fields) return { resume: null, planHandle: sub?.handle ?? null };

  const { error: writeError } = await db.from("accounts").update(fields).eq("id", installation.accountId);
  if (writeError) throw new Error(`Could not record the Shopify plan: ${writeError.message}`);

  const wasEntitled = ENTITLED.has(String(account.plan_status));
  const nowEntitled = ENTITLED.has(String(fields.plan_status));
  if (wasEntitled || !nowEntitled) return { resume: null, planHandle: sub?.handle ?? null };

  // Newly on a plan: the sites move to the plan's pace, and what the free
  // tier held back is owed, exactly as after a Stripe checkout.
  const { data: sites } = await db
    .from("workspaces")
    .select("id, auto_generate_weekly_limit")
    .eq("account_id", installation.accountId);
  for (const site of sites ?? []) {
    const next = paceOnActivation(site.auto_generate_weekly_limit as number | null, fields.plan as string);
    if (next !== null) await db.from("workspaces").update({ auto_generate_weekly_limit: next }).eq("id", site.id);
  }
  const key = `shopify:${shopGid}:${sub?.handle ?? ""}`;
  await oweResume(db, installation.accountId, key);
  return { resume: { accountId: installation.accountId, key, draftWeek: fields.plan_status === "trialing" }, planHandle: sub?.handle ?? null };
}
