-- 061: what a paused site was doing before, and since when
-- Depends on: 001_initial_schema (workspaces.status)
-- Alongside:  053_workspace_roles adds `paused_until` for the account-wide
--             pause on Billing (paused_until set = Billing paused it, with an
--             end date; NULL = paused by hand). This column is the by-hand
--             half of that story.
--
-- `status = 'paused'` already stops every cron (generate, analyze, site-pages
-- filter on it; publish does from this PR). What it could not say was when the
-- site was paused, so the banner could only read "Paused", or what it was
-- doing before, so Resume could only guess `on` - wrong for a site that was
-- still in review or setup.
--
-- One jsonb rather than two columns because it is written and cleared as a
-- unit by one action, and because nothing else on the row fits: brand_style is
-- the writing voice, business_profile is the onboarding profile,
-- topical_profile is a term-frequency map. Shape:
--   { "since": timestamptz, "previous_status": "on"|"review"|"setup", "by": uuid }
-- NULL whenever the site is not paused by hand.

alter table workspaces add column if not exists paused_meta jsonb;

comment on column workspaces.paused_meta is
  'Set by "Pause this site" with status=paused: {since, previous_status, by}. Cleared on resume. NULL unless paused by hand (see 053 paused_until for the Billing pause).';
