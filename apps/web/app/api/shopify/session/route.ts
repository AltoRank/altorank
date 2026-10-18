import { NextResponse, after } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { shopifyAppCredentials } from "@/lib/shopify/env";
import { bearerToken, verifyShopifyIdToken, ShopifyIdTokenError } from "@/lib/shopify/session-token";
import { exchangeIdToken, ShopifyInvalidIdTokenError } from "@/lib/shopify/tokens";
import { saveInstallationTokens } from "@/lib/shopify/installations";
import { provisionShop } from "@/lib/shopify/provision";
import { startShopFirstLook } from "@/lib/shopify/first-look";
import { retryWithFreshToken } from "@/lib/shopify/request-auth";
import { dispatchWorker } from "@/lib/onboarding/run-dispatch";
import { syncShopifyBilling } from "@/lib/shopify/billing";
import { dispatchResume } from "@/lib/plan/resume-dispatch";
import { recordEvent } from "@/lib/observability/record";
import { describe as describeError } from "@/lib/observability/event";

// The first look's inline fallback runs in after() on an install that cannot
// self-invoke; give it the budget /api/onboard/start has.
export const maxDuration = 300;

/**
 * POST /api/shopify/session - the embedded app's first call on every open.
 *
 * 1. App Bridge's ID token (Authorization header) is verified, then exchanged
 *    with Shopify for an expiring offline token, stored against the store.
 *    Running it on every open is what managed installation expects: install
 *    and reinstall need no OAuth step, and a store whose refresh token lapsed
 *    is healed by opening the app.
 * 2. A store opening the app for the first time gets its AltoRank account,
 *    site and publishing connection (lib/shopify/provision.ts), and its first
 *    look starts - the signup and the wizard, with nothing asked.
 *
 * A stale or bad ID token is a 401 with X-Shopify-Retry-Invalid-Session-Request,
 * which tells App Bridge to fetch a fresh one and retry once.
 * https://shopify.dev/docs/apps/build/authentication-authorization/implement-token-exchange
 */
export async function POST(request: Request) {
  const app = shopifyAppCredentials();
  if (!app) return NextResponse.json({ error: "The Shopify app is not configured on this install." }, { status: 503 });

  const idToken = bearerToken(request);
  if (!idToken) return retryWithFreshToken();

  let shop: string;
  try {
    shop = verifyShopifyIdToken(idToken, app).shop;
  } catch (err) {
    if (err instanceof ShopifyIdTokenError) return retryWithFreshToken();
    throw err;
  }

  const supabase = createServiceClient();
  let installationId: string;
  try {
    const tokens = await exchangeIdToken(shop, idToken, app);
    installationId = (await saveInstallationTokens(supabase, shop, tokens)).id;
  } catch (err) {
    if (err instanceof ShopifyInvalidIdTokenError) return retryWithFreshToken();
    return NextResponse.json({ error: "Could not connect to Shopify. Try again in a minute." }, { status: 502 });
  }

  let site;
  try {
    site = await provisionShop(supabase, { id: installationId, shop });
  } catch {
    return NextResponse.json({ error: "Could not set up AltoRank for this store. Try again in a minute." }, { status: 500 });
  }

  if (site.created) {
    const started = await startShopFirstLook(supabase, site);
    if ("runId" in started && started.created) {
      const runId = started.runId;
      after(() => dispatchWorker(runId));
    }
  }

  // 3. The plan: Shopify sends no webhook when a store subscribes or cancels,
  //    so each open reads it (lib/shopify/billing.ts). Coming back from the
  //    plan picker is an open too. A Partner API failure must not lock the
  //    merchant out of their own app; the daily sweep catches up.
  try {
    const { data: inst } = await supabase.from("shopify_installations").select("shop_gid").eq("id", installationId).single();
    const { resume } = await syncShopifyBilling(supabase, {
      id: installationId,
      shop,
      accountId: site.accountId,
      shopGid: (inst?.shop_gid as string | null) ?? null,
    });
    if (resume) after(() => dispatchResume(resume));
  } catch (err) {
    await recordEvent(
      { level: "warn", source: "shopify.billing", message: `Could not read ${shop}'s plan: ${describeError(err)}`, accountId: site.accountId },
      supabase,
    );
  }

  return NextResponse.json({ shop, installationId, created: site.created });
}
