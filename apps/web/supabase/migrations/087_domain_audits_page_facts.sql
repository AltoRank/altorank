-- 087: what the homepage said about itself, kept with the first look
--
-- `domain_audits` holds the readiness findings, the Lighthouse result and the
-- crawl's issues. The response the first look already fetched carries more
-- than those read - server, compression, text-to-markup ratio, heading
-- counts, social tags, render-blocking assets - and the onboarding screen
-- shows it as the report a person reads while the first draft is written.
-- Shape: lib/audit/page-facts.ts (PageFacts). NULL when no page was fetched.

ALTER TABLE domain_audits ADD COLUMN IF NOT EXISTS page_facts jsonb;

COMMENT ON COLUMN domain_audits.page_facts IS
  'The homepage as fetched by this audit: server, encoding, sizes, headings, social tags, render-blocking assets (lib/audit/page-facts.ts). NULL when nothing was fetched.';
