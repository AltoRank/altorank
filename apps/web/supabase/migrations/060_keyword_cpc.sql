-- 060: what one click on this keyword sells for
-- Depends on: 001_initial_schema (keywords)
--
-- Every keyword call we make already returns the Google Ads cost-per-click:
-- keywords_for_site, keyword_ideas and keyword_overview all carry
-- `keyword_info.cpc`, and lib/seo/keywords.ts has been parsing it into
-- DiscoveredKeyword.cpc since the first version. It was then dropped at the
-- upsert. So the one figure that turns "412 clicks" into a sum a client can
-- put beside an invoice was fetched, paid for, and thrown away.
--
-- The value estimate reads it as clicks × cpc over the last 30 days, per
-- query, using only terms this workspace has a CPC on file for. It is an
-- estimate and every surface that shows it says so.
--
-- NULL means no advertiser data, or stored before this column existed. The
-- research parser defaults a missing cpc to 0, and 0 must not be written
-- here: a keyword nobody bids on and a keyword we never asked about would
-- otherwise both read as "worth nothing", and the estimate would count the
-- second one as measured. Unmeasured is null, as with difficulty and dr.
--
-- `numeric` without scale: DataForSEO returns dollars with two decimals, but
-- a fixed scale would round a $0.005 long-tail term to zero and lose it.
-- Value is in USD regardless of the workspace locale, because that is the
-- currency the provider quotes in; the formatter says which currency.

ALTER TABLE keywords
  ADD COLUMN IF NOT EXISTS cpc numeric;

COMMENT ON COLUMN keywords.cpc IS
  'Google Ads cost-per-click in USD, from the keyword call that discovered the term. NULL = no advertiser data, or stored before migration 060. Never 0 for "unknown": the traffic-value estimate treats null as unmeasured and 0 as a measured zero.';
