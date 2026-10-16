/**
 * A store's permanent `*.myshopify.com` host, or null.
 *
 * Every value that names a shop arrives from outside - an ID token's `dest`,
 * a webhook header, a query parameter - and is about to become part of a URL
 * we send a client secret to. Only a bare myshopify.com host passes, so a
 * forged `evil.example/admin` can never receive one.
 * https://shopify.dev/docs/apps/build/authentication-authorization/get-access-tokens/authorization-code-grant
 */
const SHOP_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function normaliseShopDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let host = input.trim().toLowerCase();
  if (host.includes("://")) {
    try {
      host = new URL(host).host;
    } catch {
      return null;
    }
  }
  host = host.replace(/\/+$/, "");
  return SHOP_HOST.test(host) ? host : null;
}

/** The shop's Admin base URL, the form `storeUrl` takes everywhere else. */
export function shopAdminBase(shop: string): string {
  return `https://${shop}`;
}
