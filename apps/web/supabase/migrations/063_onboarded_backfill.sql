-- 063: sites that existed before the wizard count as onboarded
--
-- The dashboard layout sends a workspace to /onboarding when it has no
-- onboarded_at, no onboarding_skipped_at and no business_profile. 049 added
-- those columns and left every existing row null, so the first deploy would
-- have put every current customer - including our own sites, with thousands of
-- keywords and live articles - into a first-run wizard they cannot leave
-- without finishing or skipping, with /settings and /articles unreachable
-- until they do.
--
-- A site that was created before the wizard existed has, by definition, been
-- set up some other way. Its creation time is the honest value: it says when
-- the site started, not when a wizard ran. Rows created after this migration
-- are untouched and go through the wizard as intended.
--
-- Idempotent: only null rows are written, and a re-run finds none.
update workspaces
   set onboarded_at = created_at
 where onboarded_at is null
   and onboarding_skipped_at is null
   and created_at < now();
