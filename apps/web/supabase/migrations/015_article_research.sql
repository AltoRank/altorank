-- 015: Persist the research and fact-check behind every generated article
-- Depends on: 001_initial_schema (articles)
--
-- Before this, generation received a keyword and nothing else: the SERP
-- fetchers, keyword tools and Search Console sync fed dashboards only. These
-- columns record what the writer was actually given, so a reviewer can tell a
-- thin article from a thin SERP, and so a re-run is comparable to the original.

ALTER TABLE articles ADD COLUMN research jsonb;
ALTER TABLE articles ADD COLUMN fact_checks jsonb;

-- Denormalised from research->'intent'->>'intent' because it is filtered on in
-- list views, and a jsonb path expression there defeats indexing.
ALTER TABLE articles ADD COLUMN search_intent text
  CHECK (search_intent IN ('info', 'commercial', 'transactional', 'navigational'));

-- Nullable rather than defaulted: NULL means "generated before research
-- existed, or research could not run", which is different from "clean".
ALTER TABLE articles ADD COLUMN fact_check_verdict text
  CHECK (fact_check_verdict IN ('clean', 'review', 'high_risk'));

COMMENT ON COLUMN articles.research IS
  'ArticleResearch bundle (lib/seo/research.ts): SERP, intent, related keywords, GSC signals and a per-layer status.';
COMMENT ON COLUMN articles.fact_checks IS
  'FactCheckReport (lib/ai/fact-check.ts): extracted claims and their sourcing status.';

-- Partial index: the dashboard queries "what needs review", never "what is clean".
CREATE INDEX idx_articles_fact_check_attention
  ON articles(workspace_id, fact_check_verdict)
  WHERE fact_check_verdict IN ('review', 'high_risk');
