-- 026: not ranking is not rank zero
-- Depends on: 001_initial_schema (keyword_rankings)
--
-- `checkRankings` returns `position: null` for a keyword the domain does not
-- rank for, which is correct and is most keywords for a young site. The cron
-- then wrote `r.position ?? 0`, and the column was NOT NULL so it had nowhere
-- honest to put it.
--
-- Rank 0 sorts better than rank 1. Every one of the 14 rows in this table was a
-- keyword the site does not rank for at all, stored as the best possible
-- position, and any "average position" built on it would be nonsense.
--
-- NULL means "not in the results we checked". The distinction matters most for
-- exactly the sites this product is for: a new domain ranks for almost nothing,
-- and that is the fact the tracker exists to show changing.

ALTER TABLE keyword_rankings ALTER COLUMN position DROP NOT NULL;
UPDATE keyword_rankings SET position = NULL WHERE position = 0;

COMMENT ON COLUMN keyword_rankings.position IS
  'Organic position. NULL means the domain was not found in the results checked; never 0.';
