-- 023: an unmeasured domain rating stops being a zero
-- Depends on: 001_initial_schema (workspaces), 008-ish (backlink_exchanges)
--
-- `workspaces.dr` defaulted to 0 and no code path has ever written to it, so
-- every workspace in the database reads "DR 0" as though somebody measured it.
-- The backlink exchange prices a placement off that number: creditsForDR(0)
-- returns 1, the cheapest tier. The result is an economy where a DR 80 host and
-- a brand-new domain are worth exactly the same, and nobody can see that the
-- price was invented rather than derived.
--
-- NULL now means "nobody has measured this". A genuine DR of 0 is possible for
-- a new domain, so when real DR measurement lands it should also record when
-- the reading was taken; until something actually writes this column, NULL is
-- the only honest value it can hold.
--
-- `credits_offered` gets the same treatment for the same reason: it is derived
-- from the requester's DR, so a NOT NULL DEFAULT 0 turned an unknown into a
-- priced offer.
--
-- `workspaces.traffic` has the identical '0'::text default and is left alone
-- here: it is display-only and not part of pricing, so it belongs with the
-- dashboard fix rather than this one.

ALTER TABLE workspaces ALTER COLUMN dr DROP DEFAULT;

-- Every existing 0 is a placeholder, not a reading: nothing has ever written
-- this column outside of lib/demo-data.ts, which never touches the database.
UPDATE workspaces SET dr = NULL WHERE dr = 0;

ALTER TABLE backlink_exchanges ALTER COLUMN credits_offered DROP NOT NULL;
ALTER TABLE backlink_exchanges ALTER COLUMN credits_offered DROP DEFAULT;

UPDATE backlink_exchanges SET credits_offered = NULL WHERE credits_offered = 0;

-- The ledger records the DR a trade was priced at. A default of 0 made every
-- historical row assert a reading nobody took.
ALTER TABLE backlink_credits ALTER COLUMN dr_at_time DROP DEFAULT;
UPDATE backlink_credits SET dr_at_time = NULL WHERE dr_at_time = 0;

COMMENT ON COLUMN workspaces.dr IS
  'Domain rating 0-100. NULL means unmeasured; never coerce it to 0 for display or pricing.';
COMMENT ON COLUMN backlink_exchanges.credits_offered IS
  'Credits the requester advertises. NULL when the requesting workspace has no measured DR.';
COMMENT ON COLUMN backlink_credits.dr_at_time IS
  'Provider DR at settlement, for audit. NULL when it was never measured.';

-- Two more columns with the same defect, found by signing into the dashboard
-- and reading it rather than by grepping.
--
-- `backlinks.source_dr` defaults to 0 and feeds an average on /backlinks that
-- divides by every row, so one unmeasured link drags the reported authority of
-- the whole set toward zero.
--
-- `workspaces.traffic` defaults to the *string* '0' and is written by nothing
-- outside lib/reports/generate.ts, so every client card on the dashboard reads
-- "0 organic /mo" as though somebody measured it. It is display-only and not
-- part of any calculation, which is exactly why it went unnoticed.
ALTER TABLE backlinks ALTER COLUMN source_dr DROP DEFAULT;
UPDATE backlinks SET source_dr = NULL WHERE source_dr = 0;

ALTER TABLE workspaces ALTER COLUMN traffic DROP DEFAULT;
UPDATE workspaces SET traffic = NULL WHERE traffic = '0';

COMMENT ON COLUMN backlinks.source_dr IS
  'Referring domain rating. NULL means unmeasured; exclude from averages, never count as 0.';
COMMENT ON COLUMN workspaces.traffic IS
  'Organic sessions/mo as displayed. NULL means unmeasured; render as an em dash.';

-- `articles.volume` defaulted to 0 and nothing wrote it, so every row in the
-- articles table claimed "0 searches/mo" for a keyword the picker had chosen
-- precisely because it had volume. generate.ts now stores the real figure.
ALTER TABLE articles ALTER COLUMN volume DROP DEFAULT;
UPDATE articles SET volume = NULL WHERE volume = 0;
COMMENT ON COLUMN articles.volume IS
  'Search volume for the target keyword when the draft was written. NULL means unknown.';
