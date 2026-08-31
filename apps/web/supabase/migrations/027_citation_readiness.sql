-- 027: score whether an article can be cited, not just ranked
-- Depends on: 001_initial_schema (articles)
--
-- `seo_score` and its seven checks answer "will this rank in a list of ten
-- links". This product's claim is that it gets you named in an AI answer, and
-- nothing measured whether an article was built to be quoted: no answer-first
-- check, no definition block, no quotable-figure check, no source attribution.
--
-- lib/geo/ measures whether engines name the BRAND, which is a different fact
-- from whether a PAGE is citable. This is the page-level half.
--
-- Nullable: an article written before this existed has no reading, and 0 would
-- claim it scored badly rather than that nobody looked.

ALTER TABLE articles ADD COLUMN IF NOT EXISTS aeo_score integer;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS aeo_checks jsonb;

COMMENT ON COLUMN articles.aeo_score IS
  'Citation readiness 0-100 from lib/seo/aeo-scoring.ts. NULL means not scored, never 0.';
COMMENT ON COLUMN articles.aeo_checks IS
  'Per-check breakdown, so the number can be argued with rather than trusted.';
