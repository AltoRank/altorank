-- 021: What the domain already ranks for, stored with the audit that found it
-- Depends on: 009_domain_audits (domain_audits), 018_domain_analysis (trigger)
--
-- The first look could already say "here are keywords in your space". It could
-- not say "this post of yours sits at position 14", which is the finding that
-- makes a report about them rather than about their industry.
--
-- fetchRankedKeywords was wired into analyseDomain as a fifth layer and its
-- output reached the headline, but nothing persisted it: the rows existed for
-- the duration of one function call and were then dropped. That made the
-- expensive half of the call (a paid rank lookup) unavailable to every later
-- consumer, and meant a reviewer could read "3 keywords in striking distance"
-- in the headline with no way to see which three.
--
-- Stored on domain_audits rather than in a table of its own. Rank data is a
-- snapshot belonging to the audit that fetched it: keeping it alongside
-- `readiness` and `pagespeed` means a historical audit stays internally
-- consistent, and there is no orphan row to reconcile when an audit is deleted.
-- Per-keyword tracking over time already has a home in keyword_rankings, which
-- is a different question (our tracked terms, measured repeatedly) from this one
-- (everything this domain ranks for, once, at first look).

ALTER TABLE domain_audits ADD COLUMN ranked_keywords jsonb;

COMMENT ON COLUMN domain_audits.ranked_keywords IS
  'RankedKeyword[] (lib/seo/ranked-keywords.ts): keyword, position, url, volume, '
  'difficulty, cpc, isBlogUrl. NULL means the lookup did not run (no DataForSEO '
  'credentials, or the layer failed); an empty array means it ran and the domain '
  'ranks for nothing the index knows about. The two are deliberately distinct.';
