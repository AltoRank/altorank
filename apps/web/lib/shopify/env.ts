/**
 * The AltoRank Shopify app's own credentials and the one Admin API version
 * every call is pinned to.
 *
 * These belong to the public app merchants install from the Shopify App
 * Store, not to any merchant: a connection made by pasting a merchant's own
 * Dev Dashboard app or legacy token carries its credentials in its config
 * and never reads these.
 *
 *   SHOPIFY_API_KEY     the app's client id (public; App Bridge reads it too)
 *   SHOPIFY_API_SECRET  the app's client secret (signs ID tokens and webhooks)
 */

/**
 * Shopify releases a version a quarter and supports each for a year; a call
 * to a retired version is served by the oldest supported one, silently. One
 * constant, so moving forward is one line and a test run.
 * https://shopify.dev/docs/api/usage/versioning
 */
export const SHOPIFY_API_VERSION = "2026-10";

export interface ShopifyAppCredentials {
  clientId: string;
  clientSecret: string;
}

/** The app's credentials, or null on an install that has no Shopify app. */
export function shopifyAppCredentials(): ShopifyAppCredentials | null {
  const clientId = process.env.SHOPIFY_API_KEY?.trim();
  const clientSecret = process.env.SHOPIFY_API_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** As above, for code paths that cannot run without them. */
export function requireShopifyAppCredentials(): ShopifyAppCredentials {
  const creds = shopifyAppCredentials();
  if (!creds) throw new Error("The Shopify app is not configured: set SHOPIFY_API_KEY and SHOPIFY_API_SECRET.");
  return creds;
}
