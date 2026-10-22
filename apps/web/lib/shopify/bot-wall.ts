// ---------------------------------------------------------------------------
// A Shopify store behind its own bot wall
// ---------------------------------------------------------------------------
//
// A signup, 2026-10-21: a Shopify store with a Cloudflare managed challenge in
// front of it ("Just a moment...", `cf-mitigated: challenge`) answered 403 to
// every agent, a desktop Chrome on a home line included. Shopify itself does
// not do this - plain stores answer our crawler 200 - and no request header
// gets past a challenge. What does is the Admin API: once the store is
// connected, its pages and articles are read through Shopify instead
// (lib/shopify/store-content.ts), exactly as for a password-locked storefront.
//
// So the run screen should say "connect your Shopify store", and only to a
// store that is one. The storefront is unreadable; robots.txt usually is not
// (the challenge exempts it so search engines can still read the rules), and
// Shopify's generated robots.txt is unmistakable.

import { FALLBACK_UA } from "@/lib/audit/crawler";

/** Lines only Shopify's generated robots.txt carries. */
const SHOPIFY_ROBOTS = /we use Shopify as our ecommerce platform|\/services\/login_with_shop|\/\.well-known\/shopify\/monorail|\/cdn\/wpm\//i;

/** Whether a robots.txt body is the one Shopify generates. Pure. */
export function isShopifyRobots(body: string): boolean {
  return SHOPIFY_ROBOTS.test(body);
}

/**
 * Whether the storefront refuses a plain request: 403 or 429, or a
 * Cloudflare challenge whatever the status. A refusal like this replaces the
 * crawl with the store's own content when the store is connected.
 */
export async function storefrontWalled(domain: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`https://${domain}/`, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": FALLBACK_UA },
      signal: AbortSignal.timeout(5000),
    });
    return res.status === 403 || res.status === 429 || res.headers.get("cf-mitigated") === "challenge";
  } catch {
    return false;
  }
}

/** Whether `domain` is a Shopify store, read off its robots.txt. False on any failure. */
export async function looksLikeShopify(domain: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`https://${domain}/robots.txt`, {
      headers: { "User-Agent": FALLBACK_UA },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    return isShopifyRobots((await res.text()).slice(0, 64_000));
  } catch {
    return false;
  }
}
