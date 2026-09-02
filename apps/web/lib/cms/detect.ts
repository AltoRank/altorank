// ---------------------------------------------------------------------------
import { fetchSite } from "@/lib/audit/lenient-fetch";
// Platform detection from public signals
// ---------------------------------------------------------------------------
//
// Onboarding asked people to pick their CMS from twelve options and then find
// an API key for it. The first half of that is a question the site itself can
// answer: a WordPress install says so in a meta tag, Shopify says so in a
// response header, Webflow puts its own attribute on the <html> element.
//
// Reads public information only - one GET of the homepage - so it runs before
// anyone has connected anything, which is the whole point.
//
// Two rules it does not break:
//
//   Never guess.        A wrong platform sends someone hunting for credentials
//                       that do not exist. Detection returns null rather than a
//                       best effort, and the UI keeps the full picker.
//   Show the evidence.  Every result names the signal it matched on, so a
//                       person can tell "we saw a wp-json link" from "we think
//                       so". Confidence without a reason is just a number.

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

export type Detection = {
  platform: DetectedPlatform;
  /** high: the platform identified itself. medium: a strong asset fingerprint. */
  confidence: "high" | "medium";
  /** The literal signal matched, quoted, so the claim is checkable. */
  evidence: string;
  /**
   * Whether `lib/cms/adapter.ts` can publish to it directly.
   *
   * Detecting Astro or Hugo is still worth doing even though there is no API to
   * publish through: those sites publish from a repository, so the answer is the
   * git adapter, and saying that is more useful than an empty picker.
   */
  adapter: "direct" | "git" | "none";
};

const UA =
  "Mozilla/5.0 (compatible; AltoRank-PlatformDetect/1.0; " +
  "+https://altorank.co; publishing setup)";

type Rule = {
  platform: DetectedPlatform;
  confidence: "high" | "medium";
  adapter: Detection["adapter"];
  /** Matched against the raw HTML. */
  html?: RegExp;
  /** Matched against a `name: value` line built from the response headers. */
  header?: RegExp;
  label: string;
};

/**
 * Ordered: the first match wins, so the more specific rule goes first.
 * WooCommerce before WordPress, because every WooCommerce store is also a
 * WordPress install and the shop is the more useful answer.
 */
const RULES: Rule[] = [
  // Deliberately narrow: an earlier version matched the word "WooCommerceBlocks"
  // in wordpress.org's own marketing copy and reported a WooCommerce store.
  // Only a real plugin asset path counts, because only that means it is loaded.
  { platform: "woocommerce", confidence: "high", adapter: "direct",
    html: /wp-content\/plugins\/woocommerce\//i,
    label: "WooCommerce plugin asset path" },
  { platform: "shopify", confidence: "high", adapter: "direct",
    header: /x-shopid|x-shopify/i, label: "Shopify response header" },
  { platform: "shopify", confidence: "high", adapter: "direct",
    html: /cdn\.shopify\.com|Shopify\.theme/i, label: "Shopify CDN assets" },
  { platform: "wordpress", confidence: "high", adapter: "direct",
    html: /<meta[^>]+name=["']generator["'][^>]+content=["']WordPress/i,
    label: "generator meta tag" },
  { platform: "wordpress", confidence: "high", adapter: "direct",
    html: /\/wp-json\/|\/wp-content\/|\/wp-includes\//i, label: "wp-json / wp-content paths" },
  { platform: "ghost", confidence: "high", adapter: "direct",
    html: /<meta[^>]+name=["']generator["'][^>]+content=["']Ghost/i, label: "generator meta tag" },
  { platform: "webflow", confidence: "high", adapter: "direct",
    html: /data-wf-(?:page|site)|<meta[^>]+content=["']Webflow/i, label: "Webflow site attributes" },
  { platform: "framer", confidence: "high", adapter: "direct",
    html: /framerusercontent\.com|<meta[^>]+content=["']Framer/i, label: "Framer assets" },
  { platform: "wix", confidence: "high", adapter: "direct",
    html: /static\.parastorage\.com|X-Wix-/i, label: "Wix static assets" },
  { platform: "hubspot", confidence: "high", adapter: "direct",
    html: /hs-scripts\.com|hubspot\.(?:net|com)\/hub/i, label: "HubSpot tracking script" },
  { platform: "magento", confidence: "medium", adapter: "direct",
    html: /\/static\/version\d+\/frontend\/|Magento_/i, label: "Magento static paths" },
  { platform: "squarespace", confidence: "high", adapter: "none",
    html: /squarespace\.com|static1\.squarespace/i, label: "Squarespace assets" },

  // Repository-published sites. No API to post to, so the answer is the git
  // adapter, and knowing which generator still helps: it tells us where posts
  // live and what front matter they need.
  { platform: "astro", confidence: "medium", adapter: "git",
    html: /<meta[^>]+name=["']generator["'][^>]+content=["']Astro/i, label: "generator meta tag" },
  { platform: "hugo", confidence: "medium", adapter: "git",
    html: /<meta[^>]+name=["']generator["'][^>]+content=["']Hugo/i, label: "generator meta tag" },
  { platform: "jekyll", confidence: "medium", adapter: "git",
    html: /<meta[^>]+name=["']generator["'][^>]+content=["']Jekyll/i, label: "generator meta tag" },
  { platform: "nextjs", confidence: "medium", adapter: "git",
    html: /\/_next\/static\//i, label: "Next.js build output" },
];

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
  shopify: "Publishes to Shopify blogs. Needs an Admin API access token.",
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
 * Identify the publishing platform behind a domain.
 *
 * Returns null when nothing matched, which is a real and common answer: a
 * hand-built site, a headless setup, or anything behind a CDN that strips the
 * fingerprints. The caller shows the full picker in that case.
 */
export async function detectPlatform(domain: string): Promise<Detection | null> {
  const clean = domain.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!clean) return null;

  let res: Response;
  try {
    res = await fetchSite(`https://${clean}/`, {
      headers: { "user-agent": UA },
      redirect: "follow",
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const headerLine = [...res.headers.entries()]
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const html = (await res.text()).slice(0, 400_000);

  for (const rule of RULES) {
    const hit =
      (rule.header && rule.header.test(headerLine)) ||
      (rule.html && rule.html.test(html));
    if (!hit) continue;
    return {
      platform: rule.platform,
      confidence: rule.confidence,
      evidence: rule.label,
      adapter: rule.adapter,
    };
  }

  return null;
}
