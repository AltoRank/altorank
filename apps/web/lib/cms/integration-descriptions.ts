// ---------------------------------------------------------------------------
// What each CMS tile is allowed to say
// ---------------------------------------------------------------------------
//
// The /connect tiles and the onboarding wizard's tooltips render
// `integrations.description` verbatim, and the live values were seeded by
// migration 002 in 2026 and never revised. Six of them advertised work no
// adapter does: Wix "collections; use existing category taxonomy", Ghost
// "feature image + members visibility", Shopify "product-linked posts,
// metafields", Notion "cover / tags", Magento "and blog posts", Webflow
// "binding to your blog template", WordPress "categories". None of
// `categories`, `metafields`, `feature_image`, `visibility` or `cover`
// appears anywhere under lib/cms/.
//
// So the strings live here, next to the adapters they describe, and a
// migration writes them to the table. The test beside this file checks each
// description against the nouns its adapter does not send: the next person to
// widen a claim has to widen the adapter first.

/**
 * Tile copy for the connectors, by `integrations.id`.
 *
 * Each sentence names only fields the adapter's payload builder actually
 * sends. Non-CMS integrations (analytics, data, notify) are not listed:
 * nothing in this audit found their copy wrong, and rewriting it blind would
 * be its own guess.
 */
export const INTEGRATION_DESCRIPTIONS: Record<string, string> = {
  wordpress:
    "Posts with body, slug, excerpt, tags, featured image and Rank Math / Yoast fields",
  woocommerce:
    "Posts over the WordPress REST API, with body, slug, excerpt, tags, featured image and SEO fields",
  shopify: "Blog articles with body, tags, summary and storefront visibility",
  magento: "Static CMS pages via the REST API, at /your-slug",
  webflow: "CMS collection items, into the collection fields you choose",
  ghost: "Posts with body, slug, tags and meta description",
  framer: "CMS collection items with name, slug, content and description",
  notion: "Pages in a database: title, slug, optional status, body as blocks",
  wix: "Blog posts: title, excerpt and the body as Ricos rich content",
  hubspot: "Blog posts with slug, body and meta description",
  webhook: "POSTs the article to any URL, optionally signed with HMAC-SHA256",
};

/**
 * Tile copy for the read-only analytics connections, where the seeded row is
 * wrong. Kept apart from INTEGRATION_DESCRIPTIONS because those are also
 * written to the table by migration 065; the /connect page reads both maps
 * before the row (app/(dashboard)/connect/page.tsx), so no migration is
 * needed for these.
 *
 * GA4 was seeded as "Traffic + engagement, auto-attributed to each
 * article". The only reader of GA4 rows is the monthly report, which sums
 * pageviews and sessions for the whole site over the period
 * (aggregateReportData in lib/reports/metrics.ts). Nothing attributes them
 * to an article.
 */
export const ANALYTICS_DESCRIPTIONS: Record<string, string> = {
  ga4: "Site-wide pageviews and sessions, summed in the monthly report",
};

/**
 * Nouns a description must not use unless the named adapter sends them.
 *
 * The audit's list, kept as an assertion rather than a comment. Add to the
 * adapter first, then to this list's exceptions - not the other way round.
 */
export const UNIMPLEMENTED_FEATURE_NOUNS: readonly string[] = [
  "categor", // categories / category taxonomy - no adapter sends one
  "metafield",
  "feature image",
  "featured_image",
  "members visibility",
  "cover",
  "product-linked",
  "template",
];
