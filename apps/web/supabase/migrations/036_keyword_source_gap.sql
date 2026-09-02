-- 036: 'gap' joins the keyword sources
-- Depends on: 035_keyword_source
--
-- Discovery now asks a fourth question, and it is the strongest one available
-- to a site with no rankings of its own: what does the competition rank for
-- that we do not?
--
-- Ordered by how much the evidence is worth:
--   ranked  we hold a position          the SERP already decided, for us
--   gap     a competitor holds one      the SERP decided, for our market
--   ideas   our own headings say so     we decided
--   ads     the domain looks like this  Google Ads guessed
--
-- 'gap' rows are exempt from the topical relevance filter for the same reason
-- 'ranked' rows are: a real position held by a real competitor is evidence,
-- and the filter exists for terms nobody has tested.
ALTER TABLE keywords DROP CONSTRAINT IF EXISTS keywords_source_check;

ALTER TABLE keywords
  ADD CONSTRAINT keywords_source_check
  CHECK (source IS NULL OR source IN ('ranked', 'gap', 'ideas', 'ads'));

COMMENT ON COLUMN keywords.source IS
  'Which discovery call produced this term, strongest evidence first. ranked = we hold a SERP position. gap = a competitor holds one and we do not. ideas = seeded from our own headings. ads = the domain-level Google Ads guess. NULL = stored before migration 035.';
