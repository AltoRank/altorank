-- 042: one a day is the default, and the sites we already have get it
-- Depends on: 017_autonomous_generation (the column and its DEFAULT 2)
--             041_generation_pace (raised the ceiling to 25)
--
-- 017 set DEFAULT 2 when the generator ran once a day and could not have
-- delivered more than seven a week whatever the column said. Since 296ad6a it
-- runs four times a day, so the column is the only thing bounding a site, and 2
-- a week - about nine a month - is a number nobody chose for a reason that
-- still holds. lib/content/pace.ts already calls 7 the paid default: one a day,
-- the sentence the homepage has always used, about 30 a month.
--
-- The backfill raises 1..6 and deliberately leaves two values alone:
--
--   0   is off. Somebody paused that site, and a migration is not a reason to
--       start it writing again.
--   7+  was chosen by a human at the control 041 added, and is already at or
--       above what this sets.
--
-- Free-tier sites are included, and it changes nothing for them on its own: a
-- no-plan account gets one free draft a calendar month (FREE_DRAFTS in
-- lib/billing/quota.ts), so the extra attempts meet the quota gate and are
-- recorded as skipped rather than written. The pace is ready for the day the
-- plan is; it does not by itself spend anything.

ALTER TABLE workspaces ALTER COLUMN auto_generate_weekly_limit SET DEFAULT 7;

UPDATE workspaces
   SET auto_generate_weekly_limit = 7
 WHERE auto_generate_weekly_limit BETWEEN 1 AND 6;

COMMENT ON COLUMN workspaces.auto_generate_weekly_limit IS
  'Articles the unattended generator may write for this site per rolling week, 0-25. 0 pauses it. Defaults to 7 (one a day; lib/content/pace.ts PAID_DEFAULT_PACE). The account quota in lib/billing/quota.ts still bounds the monthly total across sites.';
