-- Tile copy that matches what the adapters send.
--
-- /connect and the onboarding wizard render `integrations.description`
-- verbatim. Migration 002 seeded these in 2026 and nothing has UPDATEd the
-- column since - 004 re-seeds five of the same ids with ON CONFLICT DO
-- NOTHING, so 002's text is what ships. Six tiles advertised work no adapter
-- does:
--
--   wix         "collections; use existing category taxonomy" - sends title,
--               excerpt and the body; no collections, no categories
--   ghost       "feature image + members visibility" - sends neither
--   shopify     "product-linked posts, metafields" - no metafields call
--               exists in lib/cms/shopify.ts, and nothing links a product
--   notion      "map title / body / cover / tags" - no cover, no tags, and
--               no mapping UI
--   magento     "CMS pages and blog posts" - posts only to V1/cmsPage
--   webflow     "binding to your blog template" - nothing touches a template
--   wordpress   "categories" - never sent
--
-- The strings are the ones in apps/web/lib/cms/integration-descriptions.ts,
-- which is the source of truth and is tested against the adapters' payloads.
-- Update both together.

update integrations set description =
  'Posts with body, slug, excerpt, tags, featured image and Rank Math / Yoast fields'
  where id = 'wordpress';
update integrations set description =
  'Posts over the WordPress REST API, with body, slug, excerpt, tags, featured image and SEO fields'
  where id = 'woocommerce';
update integrations set description =
  'Blog articles with body, tags, summary and storefront visibility'
  where id = 'shopify';
update integrations set description =
  'Static CMS pages via the REST API, at /your-slug'
  where id = 'magento';
update integrations set description =
  'CMS collection items, into the collection fields you choose'
  where id = 'webflow';
update integrations set description =
  'Posts with body, slug, tags and meta description'
  where id = 'ghost';
update integrations set description =
  'CMS collection items with name, slug, content and description'
  where id = 'framer';
update integrations set description =
  'Pages in a database: title, slug, optional status, body as blocks'
  where id = 'notion';
update integrations set description =
  'Blog posts: title, excerpt and the body as Ricos rich content'
  where id = 'wix';
update integrations set description =
  'Blog posts with slug, body and meta description'
  where id = 'hubspot';
update integrations set description =
  'POSTs the article to any URL, optionally signed with HMAC-SHA256'
  where id = 'webhook';
