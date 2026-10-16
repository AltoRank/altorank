import { shopAdminBase } from "./shop-domain";
import type { ShopifyAppCredentials } from "./env";

/**
 * The two calls that mint an installed store's access token: token exchange
 * (an App Bridge ID token in, an expiring offline token out) and refresh.
 * Both POST to the store's /admin/oauth/access_token; neither stores
 * anything, which is lib/shopify/installations.ts's job.
 *
 * New public apps must use expiring offline tokens: the access token lives an
 * hour, the refresh token 90 days and is replaced on every refresh.
 * https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens
 * https://shopify.dev/docs/apps/build/authentication-authorization/implement-token-exchange
 */

export interface ShopifyTokenSet {
  accessToken: string;
  /** Epoch ms. */
  accessExpiresAt: number;
  refreshToken: string;
  /** Epoch ms. */
  refreshExpiresAt: number;
  scopes: string | null;
}

/** The ID token was stale or bad: the embedded app should fetch a fresh one and retry. */
export class ShopifyInvalidIdTokenError extends Error {
  constructor(message = "Shopify rejected the ID token") {
    super(message);
    this.name = "ShopifyInvalidIdTokenError";
  }
}

/**
 * Shopify refused the refresh token for good (`401 invalid_request`, "This
 * request requires an active refresh_token"): unknown, superseded or expired.
 * Retrying cannot help; the merchant has to open the app once.
 */
export class ShopifyRefreshRevokedError extends Error {
  constructor(message = "Shopify no longer accepts this store's refresh token") {
    super(message);
    this.name = "ShopifyRefreshRevokedError";
  }
}

const GRANT_TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
const ID_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id_token";
const OFFLINE_TOKEN_TYPE = "urn:shopify:params:oauth:token-type:offline-access-token";

/**
 * Read a token response. `expires_in` is read rather than assumed (Shopify
 * says not to hard-code the hour), and a response without a refresh token is
 * refused: it would mean a non-expiring token, which a public app may not use
 * and which this storage cannot renew.
 */
export function parseTokenResponse(data: unknown, now: number = Date.now()): ShopifyTokenSet {
  const d = (data ?? {}) as Record<string, unknown>;
  const accessToken = typeof d.access_token === "string" ? d.access_token : "";
  const refreshToken = typeof d.refresh_token === "string" ? d.refresh_token : "";
  if (!accessToken) throw new Error("Shopify returned no access token");
  if (!refreshToken) throw new Error("Shopify returned no refresh token (was expiring=1 sent?)");
  const expiresIn = typeof d.expires_in === "number" && d.expires_in > 0 ? d.expires_in : 3600;
  const refreshIn =
    typeof d.refresh_token_expires_in === "number" && d.refresh_token_expires_in > 0
      ? d.refresh_token_expires_in
      : 90 * 24 * 3600;
  return {
    accessToken,
    accessExpiresAt: now + expiresIn * 1000,
    refreshToken,
    refreshExpiresAt: now + refreshIn * 1000,
    scopes: typeof d.scope === "string" ? d.scope : null,
  };
}

async function postToken(shop: string, body: URLSearchParams): Promise<Response> {
  return fetch(`${shopAdminBase(shop)}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
}

/**
 * Trade a verified ID token for an expiring offline access token.
 *
 * Shopify answers a stale or bad ID token with 400. That is routine (they
 * live a minute), so it becomes ShopifyInvalidIdTokenError, which the caller
 * turns into a 401 with X-Shopify-Retry-Invalid-Session-Request so App Bridge
 * retries with a fresh one. Anything else is a real failure.
 */
export async function exchangeIdToken(
  shop: string,
  idToken: string,
  app: ShopifyAppCredentials,
): Promise<ShopifyTokenSet> {
  const res = await postToken(
    shop,
    new URLSearchParams({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      grant_type: GRANT_TOKEN_EXCHANGE,
      subject_token: idToken,
      subject_token_type: ID_TOKEN_TYPE,
      requested_token_type: OFFLINE_TOKEN_TYPE,
      expiring: "1",
    }),
  );
  if (res.status === 400) throw new ShopifyInvalidIdTokenError();
  if (!res.ok) {
    // Shopify's error body never echoes the secret; ours must not either.
    throw new Error(`Shopify token exchange failed (${res.status})`);
  }
  return parseTokenResponse(await res.json());
}

/**
 * Renew an access token with the stored refresh token.
 *
 * Network errors, timeouts, 429 and 5xx are safe to retry with the same
 * refresh token, so they surface as ordinary errors; only the documented
 * terminal 401 becomes ShopifyRefreshRevokedError.
 */
export async function refreshAccessToken(
  shop: string,
  refreshToken: string,
  app: ShopifyAppCredentials,
): Promise<ShopifyTokenSet> {
  const res = await postToken(
    shop,
    new URLSearchParams({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  );
  if (res.status === 401) throw new ShopifyRefreshRevokedError();
  if (!res.ok) throw new Error(`Shopify token refresh failed (${res.status})`);
  return parseTokenResponse(await res.json());
}
