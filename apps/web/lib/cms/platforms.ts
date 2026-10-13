// ---------------------------------------------------------------------------
// Publishing platforms: names, hints and what a workspace knows about its own
// ---------------------------------------------------------------------------
//
// The display half of platform detection (lib/cms/detect.ts), kept apart
// because it is read in the browser: the article editor is a client component
// and shows the detected platform's name, hint and connect tab. detect.ts
// fetches a homepage over node:http and node:https, which Next can only put in
// a browser bundle by shipping polyfills for them, and it did - until
// 2026-09-25, when a guard (lib/__tests__/client-bundle-guard.test.ts) found
// the chain. No imports here, on purpose.

export type DetectedPlatform =
  | "wordpress"
  | "shopify"
  | "webflow"
  | "ghost"
  | "framer"
  | "wix"
  | "hubspot"
  | "magento"
  | "woocommerce"
  | "squarespace"
  | "nextjs"
  | "astro"
  | "hugo"
  | "jekyll";

/** Display name, because the stored value is a lowercase identifier. */
export const PLATFORM_LABEL: Record<DetectedPlatform, string> = {
  wordpress: "WordPress",
  woocommerce: "WooCommerce",
  shopify: "Shopify",
  webflow: "Webflow",
  ghost: "Ghost",
  framer: "Framer",
  wix: "Wix",
  hubspot: "HubSpot",
  magento: "Magento",
  squarespace: "Squarespace",
  nextjs: "Next.js",
  astro: "Astro",
  hugo: "Hugo",
  jekyll: "Jekyll",
};

/** Where a detected platform's posts are published from, in one line. */
export const PLATFORM_HINT: Record<DetectedPlatform, string> = {
  wordpress: "Publishes over the WordPress REST API. Needs an application password.",
  woocommerce: "Publishes over the WordPress REST API. Needs an application password.",
  shopify: "Publishes to Shopify blogs. Needs a custom app's Client ID and secret, or a legacy Admin API access token.",
  webflow: "Publishes to a Webflow CMS collection. Needs an API token and collection id.",
  ghost: "Publishes over the Ghost Admin API. Needs an Admin API key.",
  framer: "Publishes to a Framer CMS collection.",
  wix: "Publishes to Wix Blog. Needs an API key and site id.",
  hubspot: "Publishes to the HubSpot blog. Needs a private app token.",
  magento: "Publishes to Magento. Needs an integration token.",
  squarespace:
    "Squarespace has no write API for blog posts, so publishing has to stay manual. Everything else still works.",
  nextjs: "Publishes as a Markdown file committed to the repository your site builds from.",
  astro: "Publishes as a Markdown file committed to the repository your site builds from.",
  hugo: "Publishes as a Markdown file committed to the repository your site builds from.",
  jekyll: "Publishes as a Markdown file committed to the repository your site builds from.",
};

/**
 * Which tab of the connect dialog a detected platform lands on, so "Connect
 * Webflow" can open on Webflow rather than on a twelve-tab picker. Null for a
 * platform with nothing to connect (Squarespace has no write API).
 */
export const PLATFORM_CONNECT_TYPE: Record<DetectedPlatform, string | null> = {
  // The plugin path, not the application-password one: it needs no WordPress
  // user account and is the only one that writes every SEO plugin's fields.
  wordpress: "wordpress-plugin",
  woocommerce: "woocommerce",
  shopify: "shopify",
  webflow: "webflow",
  ghost: "ghost",
  framer: "framer",
  wix: "wix",
  hubspot: "hubspot",
  magento: "magento",
  squarespace: null,
  nextjs: "git",
  astro: "git",
  hugo: "git",
  jekyll: "git",
};

/**
 * What the workspace knows about its own platform.
 *
 * Three states, because two of them used to be indistinguishable: the
 * analysis only wrote `detected_platform_at` when a rule matched, so a site
 * that had been fetched and found to run nothing we can post to looked exactly
 * like a site nobody had looked at. The editor could only say "connect a CMS"
 * to both. Now the analysis stamps the time on every run, and this reads it.
 */
export type PlatformState =
  | { state: "matched"; platform: DetectedPlatform; checkedAt: string | null }
  | { state: "checked"; checkedAt: string }
  | { state: "unchecked" };

export function platformState(ws: {
  detected_platform: string | null;
  detected_platform_at: string | null;
}): PlatformState {
  if (ws.detected_platform && ws.detected_platform in PLATFORM_LABEL) {
    return { state: "matched", platform: ws.detected_platform as DetectedPlatform, checkedAt: ws.detected_platform_at };
  }
  if (ws.detected_platform_at) return { state: "checked", checkedAt: ws.detected_platform_at };
  return { state: "unchecked" };
}
