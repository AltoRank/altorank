-- 019: Store what each site is actually about
-- Depends on: 001_initial_schema (workspaces)
--
-- Keyword recommendations scored volume and difficulty with no third axis for
-- relevance, so an autonomous run picked "ai book" for an AI operations
-- consultancy and wrote a book listicle for it. The fact checker passed it,
-- correctly: the article was true, just about the wrong subject.
--
-- The vocabulary needed to catch that is derived during the first-look crawl,
-- which already reads up to 40 pages of titles, headings and meta descriptions.
-- Storing it here means recommendations can score against it without re-crawling
-- on every run.

ALTER TABLE workspaces ADD COLUMN topical_profile jsonb;

COMMENT ON COLUMN workspaces.topical_profile IS
  'TopicalProfile (lib/seo/topical-profile.ts): weighted vocabulary from the site''s own titles and headings, used to score keyword relevance. NULL means never crawled, and relevance is left unscored rather than assumed low.';
