import { createHmac, timingSafeEqual } from "node:crypto";
import { normaliseShopDomain } from "./shop-domain";

/**
 * Verify an ID token (formerly "session token") from App Bridge.
 *
 * The embedded app runs in an iframe inside the Shopify admin, where our own
 * Supabase cookies are not sent, so this JWT is the only proof of who is
 * asking. Shopify signs it HS256 with the app's client secret. The checks are
 * Shopify's list: signature, `exp` in the future, `nbf` in the past, `aud`
 * equal to our client id, and `iss` and `dest` naming the same store.
 * https://shopify.dev/docs/apps/build/authentication-authorization/id-tokens
 *
 * Hand-rolled on node:crypto rather than a JWT library: one algorithm, one
 * key, five claims, and pinning `alg` here is what keeps a token signed some
 * other way (or `none`) from being accepted.
 */

export interface ShopifyIdToken {
  /** The store, as its myshopify.com host. */
  shop: string;
  /** The Shopify user the token was issued for. */
  sub: string | null;
  sid: string | null;
}

export class ShopifyIdTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShopifyIdTokenError";
  }
}

/** ID tokens live a minute; a few seconds of skew between clocks is normal. */
const LEEWAY_SECONDS = 10;

function base64UrlDecode(part: string): Buffer {
  return Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function hostOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

export function verifyShopifyIdToken(
  token: string,
  app: { clientId: string; clientSecret: string },
  nowSeconds: number = Math.floor(Date.now() / 1000),
): ShopifyIdToken {
  const parts = token.split(".");
  if (parts.length !== 3) throw new ShopifyIdTokenError("Malformed ID token");
  const [headerPart, payloadPart, signaturePart] = parts;

  let header: { alg?: unknown };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(base64UrlDecode(headerPart).toString("utf8"));
    payload = JSON.parse(base64UrlDecode(payloadPart).toString("utf8"));
  } catch {
    throw new ShopifyIdTokenError("Malformed ID token");
  }
  if (header.alg !== "HS256") throw new ShopifyIdTokenError("Unexpected ID token algorithm");

  const expected = createHmac("sha256", app.clientSecret).update(`${headerPart}.${payloadPart}`).digest();
  const given = base64UrlDecode(signaturePart);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new ShopifyIdTokenError("ID token signature does not match");
  }

  const exp = typeof payload.exp === "number" ? payload.exp : NaN;
  const nbf = typeof payload.nbf === "number" ? payload.nbf : NaN;
  if (!(exp + LEEWAY_SECONDS > nowSeconds)) throw new ShopifyIdTokenError("ID token has expired");
  if (!(nbf - LEEWAY_SECONDS <= nowSeconds)) throw new ShopifyIdTokenError("ID token is not valid yet");

  // `aud` is a string in Shopify's tokens; accept the array form JWT allows.
  const aud = payload.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(app.clientId)) throw new ShopifyIdTokenError("ID token was issued for another app");

  const issHost = hostOf(payload.iss);
  const destHost = hostOf(payload.dest);
  if (!issHost || !destHost || issHost !== destHost) {
    throw new ShopifyIdTokenError("ID token issuer and destination differ");
  }
  const shop = normaliseShopDomain(destHost);
  if (!shop) throw new ShopifyIdTokenError("ID token names no Shopify store");

  return {
    shop,
    sub: typeof payload.sub === "string" ? payload.sub : null,
    sid: typeof payload.sid === "string" ? payload.sid : null,
  };
}

/** The token from an `Authorization: Bearer …` header, or null. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}
