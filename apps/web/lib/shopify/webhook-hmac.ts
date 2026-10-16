import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Whether a webhook body was signed by Shopify.
 *
 * `X-Shopify-Hmac-Sha256` is the base64 HMAC-SHA256 of the raw body, keyed
 * with the app's client secret. It has to be computed over the bytes exactly
 * as they arrived, so the caller passes `await request.text()` and parses
 * JSON only after this returns true.
 * https://shopify.dev/docs/apps/build/webhooks/subscribe/https
 */
export function verifyShopifyWebhook(rawBody: string, hmacHeader: string | null, clientSecret: string): boolean {
  if (!hmacHeader) return false;
  const expected = createHmac("sha256", clientSecret).update(rawBody, "utf8").digest();
  const given = Buffer.from(hmacHeader, "base64");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
