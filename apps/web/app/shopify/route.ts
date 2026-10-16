import { shopifyAppCredentials } from "@/lib/shopify/env";
import { normaliseShopDomain } from "@/lib/shopify/shop-domain";

/**
 * GET /shopify - the AltoRank app inside the Shopify admin (the App URL in
 * shopify/shopify.app.toml).
 *
 * A route handler serving its own document rather than a page under the root
 * layout, for three reasons:
 *  - App Bridge has to be the first script in <head>, synchronous. Next puts
 *    its own scripts above anything a layout adds, and Shopify's automated
 *    review check is known to fail on exactly that.
 *  - The root layout's dark-mode script and fonts have no place inside the
 *    Shopify admin; Polaris web components carry Shopify's own look.
 *  - Nothing here needs a session: the document is static, and the script
 *    (public/shopify/app.js) authenticates every API call with an ID token.
 *
 * The frame-ancestors header lets exactly this store's admin frame it.
 * https://shopify.dev/docs/apps/build/security/set-up-iframe-protection
 */
export function GET(request: Request) {
  const app = shopifyAppCredentials();
  if (!app) {
    return new Response("The AltoRank Shopify app is not configured on this server.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const shop = normaliseShopDomain(new URL(request.url).searchParams.get("shop"));
  const ancestors = ["https://admin.shopify.com", ...(shop ? [`https://${shop}`] : [])].join(" ");
  // Busts the browser cache of app.js on each deploy.
  const version = encodeURIComponent((process.env.VERCEL_GIT_COMMIT_SHA ?? "dev").slice(0, 12));

  return new Response(embeddedDocument(app.clientId, version), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `frame-ancestors ${ancestors};`,
      "Cache-Control": "no-store",
    },
  });
}

/** The client id is ours and public; it is still escaped, being interpolated into HTML. */
function embeddedDocument(clientId: string, version: string): string {
  const key = clientId.replace(/[^A-Za-z0-9_-]/g, "");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="shopify-api-key" content="${key}">
<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
<script src="https://cdn.shopify.com/shopifycloud/polaris-1.js"></script>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AltoRank</title>
</head>
<body>
<div id="app"><s-page heading="AltoRank"><s-section><s-stack direction="inline" gap="base" alignItems="center"><s-spinner accessibilityLabel="Loading"></s-spinner><s-text>Connecting to your store…</s-text></s-stack></s-section></s-page></div>
<script type="module" src="/shopify/app.js?v=${version}"></script>
</body>
</html>
`;
}
