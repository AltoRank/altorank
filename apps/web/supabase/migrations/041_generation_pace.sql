-- 041: let a site reach the volume its plan sells
-- Depends on: 017_autonomous_generation (auto_generate_weekly_limit)
--
-- Managed sells 100 articles a month and Agency 400, and the per-site ceiling
-- from 017 was 20 a week. Twenty a week is about 87 a month, so a customer who
-- turned the setting to its maximum still could not reach the number they had
-- bought - and until 296ad6a the schedule could not have delivered it either.
-- With four runs a day the schedule is no longer the constraint, so this was
-- the last thing in the way. Twenty-five a week is about 108 a month, which
-- puts the account's own monthly quota back in charge of the total, where the
-- price actually lives.
--
-- The default stays 2. This raises what a customer MAY choose, not what
-- happens to them by default.

ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_auto_generate_weekly_limit_check;
ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_auto_generate_weekly_limit_check
  CHECK (auto_generate_weekly_limit BETWEEN 0 AND 25);

COMMENT ON COLUMN workspaces.auto_generate_weekly_limit IS
  'Articles the unattended generator may write for this site per rolling week, 0-25. 0 pauses it. The account quota in lib/billing/quota.ts still bounds the monthly total across sites.';
