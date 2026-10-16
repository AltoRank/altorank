import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { shopifyAppCredentials } from "@/lib/shopify/env";
import { bearerToken, verifyShopifyIdToken, ShopifyIdTokenError } from "@/lib/shopify/session-token";
import { exchangeIdToken, ShopifyInvalidIdTokenError } from "@/lib/shopify/tokens";
import { saveInstallationTokens } from "@/lib/shopify/installations";

/**
 * POST /api/shopify/session - the embedded app's first call on every open.
 *
 * App Bridge's ID token comes in the Authorization header. It is verified
 * here, then exchanged with Shopify for an expiring offline token, which is
 * stored against the store. Running it on every open is what Shopify's
 * managed installation expects: install and reinstall need no separate OAuth
 * step, and a store whose refresh token lapsed is healed by simply opening
 * the app.
 *
 * A stale or bad ID token is a 401 carrying X-Shopify-Retry-Invalid-Session-Request,
 * which tells App Bridge to fetch a fresh one and retry once.
 * https://shopify.dev/docs/apps/build/authentication-authorization/implement-token-exchange
 */
export async function POST(request: Request) {
  const app = shopifyAppCredentials();
  if (!app) return NextResponse.json({ error: "The Shopify app is not configured on this install." }, { status: 503 });

  const retry = () =>
    NextResponse.json(
      { error: "Shopify session expired" },
      { status: 401, headers: { "X-Shopify-Retry-Invalid-Session-Request": "1" } },
    );

  const idToken = bearerToken(request);
  if (!idToken) return retry();

  let shop: string;
  try {
    shop = verifyShopifyIdToken(idToken, app).shop;
  } catch (err) {
    if (err instanceof ShopifyIdTokenError) return retry();
    throw err;
  }

  try {
    const tokens = await exchangeIdToken(shop, idToken, app);
    const supabase = createServiceClient();
    const { id } = await saveInstallationTokens(supabase, shop, tokens);
    const { data } = await supabase
      .from("shopify_installations")
      .select("account_id, workspace_id")
      .eq("id", id)
      .maybeSingle();
    return NextResponse.json({
      shop,
      installationId: id,
      linked: Boolean(data?.account_id && data?.workspace_id),
    });
  } catch (err) {
    if (err instanceof ShopifyInvalidIdTokenError) return retry();
    return NextResponse.json({ error: "Could not connect to Shopify. Try again in a minute." }, { status: 502 });
  }
}
