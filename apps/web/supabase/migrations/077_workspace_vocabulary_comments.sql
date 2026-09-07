-- 077: the schema comments call a workspace a "site" in four places
-- Depends on: 001_initial_schema (workspaces, invites), 053_workspace_roles
--             (invites.workspace_ids), 061_workspace_pause_meta (paused_meta),
--             052_refresh_engine (refresh_days)
--
-- POSITIONING.md settled the noun on 2026-08-30: an agency is the account, a
-- workspace is one site, and "site" means the real website out on the internet.
-- The schema itself already obeys that everywhere it counts — every scoped
-- table has `workspace_id`, every account-scoped one has `agency_id`, and
-- `site_pages` is correctly named because its rows really are pages of the
-- customer's website. Nothing here is renamed.
--
-- What is wrong is four column comments, which name the *entity* "site" and so
-- teach the wrong noun to whoever reads `\d+ workspaces` before writing the
-- next feature. `invites.workspace_ids` is the clearest: it says its semantics
-- are the "same" as `agency_members.workspace_ids`, whose own comment says
-- "every workspace", and then calls them sites.
--
-- Comments only: no DDL, no lock beyond the catalogue row, nothing to roll
-- back but the old wording. Safe to re-run — `comment on` replaces.

comment on column workspaces.auto_generate_weekly_limit is
  'Articles the unattended generator may write for this workspace per rolling week, 0-25. 0 pauses it. Defaults to 7 (one a day; lib/content/pace.ts PAID_DEFAULT_PACE). The account quota in lib/billing/quota.ts still bounds the monthly total across workspaces.';

comment on column workspaces.paused_meta is
  'Set by "Pause this workspace" with status=paused: {since, previous_status, by}. Cleared on resume. NULL unless paused by hand (see 053 paused_until for the Billing pause).';

comment on column workspaces.refresh_days is
  'Weekdays (0=Sun..6=Sat) on which the refresh cron may run one scheduled rewrite for this workspace. At most two. Each rewrite consumes one slot of the article pace.';

comment on column invites.workspace_ids is
  'Copied onto agency_members.workspace_ids when the invite is accepted. Same semantics: NULL is all workspaces.';
