-- 037: Bing Webmaster Tools as a second search console
-- Depends on: 002_backend_additions (integrations seed), 006_analytics_metrics
--
-- Bing serves its own results and, through its index, Yahoo's and DuckDuckGo's,
-- and runs Copilot's web retrieval. Small next to Google, but measured is
-- measured. lib/bing/webmaster.ts reads clicks and impressions per day with the
-- account's API key; only the daily series is stored, because Bing's query and
-- page reports are weekly aggregates with a single date on them, and a week's
-- total filed under one day would inflate every sum that touched it.

INSERT INTO integrations (id, name, tag, description, icon_key) VALUES
  ('bing', 'Bing Webmaster', 'Analytics',
   'Clicks and impressions per day from Bing, which also serves Yahoo and DuckDuckGo', 'bing')
ON CONFLICT (id) DO NOTHING;

-- The source check listed the two Google feeds by name. Constraint name is the
-- one Postgres gave the inline CHECK in 006, confirmed against the hosted
-- project on 2026-09-02.
ALTER TABLE analytics_metrics DROP CONSTRAINT IF EXISTS analytics_metrics_source_check;
ALTER TABLE analytics_metrics
  ADD CONSTRAINT analytics_metrics_source_check CHECK (source IN ('ga4', 'gsc', 'bing'));

COMMENT ON COLUMN analytics_metrics.source IS
  'ga4 | gsc | bing. Bing rows are daily site totals only: query and page_url are always null for them.';
