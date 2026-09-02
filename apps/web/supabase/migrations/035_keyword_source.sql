-- 035: where a keyword came from
-- Depends on: 001_initial_schema (keywords)
--
-- lib/audit/domain-analysis.ts already makes the call this column exists to
-- preserve. When it stores candidates it exempts ranked terms from the
-- relevance filter, and says why:
--
--   "A term the site ranks for is on-topic by definition, whatever the
--    profile says: the SERP already decided."
--
-- That judgement was then thrown away. lib/seo/recommendations.ts re-scores
-- every stored keyword at selection time with no idea where it came from, and
-- multiplies its score by relevance squared - so a term the site genuinely
-- ranks for is demoted for failing a filter it was explicitly excused from an
-- hour earlier.
--
-- Measured on cal.com, which ranks 10-15 for "google calendar" (3.35M/mo):
-- scoreRelevance gives it 0, because "google" is absent from cal.com's own
-- headings. The SERP disagrees, and the SERP is the authority on this.
--
-- NULL means "recorded before this column existed", which is not the same as
-- "came from the ads endpoint" - every row predating migration 035 was stored
-- by the old keywords_for_site-only path, but we cannot prove that per row, so
-- the code treats NULL as unproven rather than inventing a provenance.

ALTER TABLE keywords
  ADD COLUMN IF NOT EXISTS source text;

ALTER TABLE keywords
  DROP CONSTRAINT IF EXISTS keywords_source_check;

ALTER TABLE keywords
  ADD CONSTRAINT keywords_source_check
  CHECK (source IS NULL OR source IN ('ranked', 'ideas', 'ads'));

COMMENT ON COLUMN keywords.source IS
  'Which discovery call produced this term. ranked = dataforseo_labs ranked_keywords, i.e. the site already ranks for it, which is proof of relevance and exempts it from the topical filter. ideas = seeded expansion. ads = the domain-level Google Ads endpoint. NULL = stored before migration 035; provenance unknown.';
