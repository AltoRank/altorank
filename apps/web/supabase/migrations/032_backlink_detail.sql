-- 032: the rest of what a backlink is
-- Depends on: 001_initial_schema (backlinks)
--
-- The table stored a source domain, an authority number, an anchor and a
-- target. A person checking a link wants to open the page it sits on, know
-- whether it passes authority at all, and see how long it has been there.
-- All three come back in the same DataForSEO response we already pay for and
-- were being discarded.

ALTER TABLE backlinks ADD COLUMN IF NOT EXISTS source_url text;
ALTER TABLE backlinks ADD COLUMN IF NOT EXISTS is_dofollow boolean;
ALTER TABLE backlinks ADD COLUMN IF NOT EXISTS first_seen timestamptz;
ALTER TABLE backlinks ADD COLUMN IF NOT EXISTS last_seen timestamptz;

COMMENT ON COLUMN backlinks.source_url IS 'The exact page the link sits on, not just its domain.';
COMMENT ON COLUMN backlinks.is_dofollow IS 'False means rel=nofollow/ugc/sponsored: it passes no authority. Null means the provider did not say.';
