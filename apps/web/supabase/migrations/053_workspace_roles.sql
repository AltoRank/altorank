-- 053: workspace-scoped members, pausing, and the reason someone left
-- Depends on: 001 (agency_members, workspaces, user_agency_ids), 010/011
-- (invites), 016 (user_admin_agency_ids), and every workspace-scoped table
-- whose policy is rewritten below.
--
-- ============================================================
-- 1. Who may see which site
-- ============================================================
--
-- RLS has drawn one boundary: the agency. A member saw every workspace on the
-- account, and the role column decided only who could invite, rebrand and pay.
-- An agency that hires a freelance writer for one client has no way to give
-- them that client and nothing else.
--
-- `agency_members.workspace_ids` is that way. NULL means what it has always
-- meant - every workspace on the account, including ones created later - and
-- an array means exactly those. Roles are unchanged: owner, admin, editor.
--
-- `user_workspace_ids()` is the new predicate. It returns the workspaces the
-- caller may see across all their memberships: for a NULL membership, every
-- workspace of that agency; for an array, the array. Every policy that used to
-- read
--
--     workspace_id in (select id from workspaces where agency_id in (select user_agency_ids()))
--
-- now reads
--
--     workspace_id in (select user_workspace_ids())
--
-- which is the same set for an unrestricted member and a subset for a
-- restricted one. SECURITY DEFINER, like user_agency_ids(): the function reads
-- workspaces and agency_members without their own policies applying, which is
-- what lets it be called from those tables' policies without recursing.
--
-- The `workspaces` table itself cannot use the set: an INSERT ... RETURNING
-- checks the new row against the SELECT policy inside the same statement, and
-- a STABLE function does not see a row the statement is still inserting. So
-- workspaces gets a per-row check on its own columns instead
-- (`user_can_access_workspace`). Same answer, different shape, for the one
-- table whose rows are the thing being scoped.
--
-- Adding a workspace is reserved to members with NULL access. A restricted
-- member who created a site would not be able to see it a moment later, which
-- is not a useful thing to let happen.
--
-- Every function below is keyed on auth.uid(). The first predicate in each
-- body is `user_id = auth.uid()`: an anonymous caller has no uid, the join
-- matches nothing, and the function returns the empty set (or false). That is
-- the whole enforcement, on purpose. EXECUTE is deliberately NOT revoked from
-- anon: on the Postgres 17.6 image local Supabase ships, calling any function
-- whose EXECUTE has been revoked from the calling role segfaults the backend
-- (reproduced 2026-09-04 with a one-line probe function), and a policy that
-- can take the database down is worse than one that returns nothing.
--
-- `enable row level security` is repeated before each policy. It is a no-op
-- where 001-049 already ran, and it is the difference between a policy and a
-- decoration on a database where one of those migrations did not: the local
-- DB this was tested on had analytics_metrics with RLS off despite 038.

alter table agency_members
  add column if not exists workspace_ids uuid[];

comment on column agency_members.workspace_ids is
  'NULL = every workspace on the agency, including future ones. An array = exactly those workspaces. Read by user_workspace_ids().';

alter table invites
  add column if not exists workspace_ids uuid[];

comment on column invites.workspace_ids is
  'Copied onto agency_members.workspace_ids when the invite is accepted. Same semantics: NULL is all sites.';

-- caller: authenticated
create or replace function public.user_workspace_ids()
returns setof uuid
language sql
stable security definer
set search_path = public
as $$
  select w.id
  from agency_members m
  join workspaces w on w.agency_id = m.agency_id
  where m.user_id = auth.uid()
    and (m.workspace_ids is null or w.id = any (m.workspace_ids));
$$;

comment on function public.user_workspace_ids() is
  'Workspaces the caller may see: all of an agency''s for a NULL membership, the listed ones otherwise. The RLS predicate for every workspace-scoped table.';

-- Per-row form, for the workspaces table (see the note above on RETURNING).
-- caller: authenticated
create or replace function public.user_can_access_workspace(p_agency_id uuid, p_workspace_id uuid)
returns boolean
language sql
stable security definer
set search_path = public
as $$
  select exists (
    select 1
    from agency_members m
    where m.user_id = auth.uid()
      and m.agency_id = p_agency_id
      and (m.workspace_ids is null or p_workspace_id = any (m.workspace_ids))
  );
$$;

-- Agencies where the caller may see every site, so may add one.
-- caller: authenticated
create or replace function public.user_full_access_agency_ids()
returns setof uuid
language sql
stable security definer
set search_path = public
as $$
  select agency_id from agency_members
  where user_id = auth.uid() and workspace_ids is null;
$$;

-- --- workspaces -----------------------------------------------------------

drop policy if exists "Workspaces by agency" on workspaces;

alter table workspaces enable row level security;
drop policy if exists "Workspaces by access" on workspaces;
create policy "Workspaces by access" on workspaces
  for select using (user_can_access_workspace(agency_id, id));

drop policy if exists "Workspaces updated by access" on workspaces;
create policy "Workspaces updated by access" on workspaces
  for update using (user_can_access_workspace(agency_id, id))
  with check (user_can_access_workspace(agency_id, id));

drop policy if exists "Workspaces deleted by access" on workspaces;
create policy "Workspaces deleted by access" on workspaces
  for delete using (user_can_access_workspace(agency_id, id));

drop policy if exists "Workspaces added by full-access members" on workspaces;
create policy "Workspaces added by full-access members" on workspaces
  for insert with check (agency_id in (select user_full_access_agency_ids()));

-- --- direct children: workspace_id column ---------------------------------

drop policy if exists "Articles by agency" on articles;
alter table articles enable row level security;
drop policy if exists "Articles by access" on articles;
create policy "Articles by access" on articles
  for all using (workspace_id in (select user_workspace_ids()));

drop policy if exists "Keywords by agency" on keywords;
alter table keywords enable row level security;
drop policy if exists "Keywords by access" on keywords;
create policy "Keywords by access" on keywords
  for all using (workspace_id in (select user_workspace_ids()));

drop policy if exists "Backlinks by agency" on backlinks;
alter table backlinks enable row level security;
drop policy if exists "Backlinks by access" on backlinks;
create policy "Backlinks by access" on backlinks
  for all using (workspace_id in (select user_workspace_ids()));

drop policy if exists "Calendar by agency" on calendar_entries;
alter table calendar_entries enable row level security;
drop policy if exists "Calendar by access" on calendar_entries;
create policy "Calendar by access" on calendar_entries
  for all using (workspace_id in (select user_workspace_ids()));

drop policy if exists "WS integrations by agency" on workspace_integrations;
alter table workspace_integrations enable row level security;
drop policy if exists "WS integrations by access" on workspace_integrations;
create policy "WS integrations by access" on workspace_integrations
  for all using (workspace_id in (select user_workspace_ids()));

drop policy if exists "Voice by agency" on voice_profiles;
alter table voice_profiles enable row level security;
drop policy if exists "Voice by access" on voice_profiles;
create policy "Voice by access" on voice_profiles
  for all using (workspace_id in (select user_workspace_ids()));

drop policy if exists "Reports by agency" on reports;
alter table reports enable row level security;
drop policy if exists "Reports by access" on reports;
create policy "Reports by access" on reports
  for all using (workspace_id in (select user_workspace_ids()));

drop policy if exists "Generation jobs by agency" on generation_jobs;
alter table generation_jobs enable row level security;
drop policy if exists "Generation jobs by access" on generation_jobs;
create policy "Generation jobs by access" on generation_jobs
  for all using (workspace_id in (select user_workspace_ids()));

drop policy if exists "Cadences by agency" on publishing_cadences;
alter table publishing_cadences enable row level security;
drop policy if exists "Cadences by access" on publishing_cadences;
create policy "Cadences by access" on publishing_cadences
  for all using (workspace_id in (select user_workspace_ids()));

drop policy if exists "Publish log by agency" on publish_log;
alter table publish_log enable row level security;
drop policy if exists "Publish log by access" on publish_log;
create policy "Publish log by access" on publish_log
  for all using (workspace_id in (select user_workspace_ids()));

drop policy if exists "Audits by agency" on domain_audits;
alter table domain_audits enable row level security;
drop policy if exists "Audits by access" on domain_audits;
create policy "Audits by access" on domain_audits
  for all using (workspace_id in (select user_workspace_ids()));

drop policy if exists "Members see own geo prompts" on geo_prompts;
alter table geo_prompts enable row level security;
drop policy if exists "Geo prompts by access" on geo_prompts;
create policy "Geo prompts by access" on geo_prompts
  for all using (workspace_id in (select user_workspace_ids()));

drop policy if exists "Members see own geo results" on geo_results;
alter table geo_results enable row level security;
drop policy if exists "Geo results by access" on geo_results;
create policy "Geo results by access" on geo_results
  for all using (workspace_id in (select user_workspace_ids()));

drop policy if exists "Spend by agency" on provider_spend;
alter table provider_spend enable row level security;
drop policy if exists "Spend by access" on provider_spend;
create policy "Spend by access" on provider_spend
  for select using (workspace_id in (select user_workspace_ids()));

drop policy if exists "Members see their own workspaces' history" on workspace_metrics;
alter table workspace_metrics enable row level security;
drop policy if exists "Workspace metrics by access" on workspace_metrics;
create policy "Workspace metrics by access" on workspace_metrics
  for select using (workspace_id in (select user_workspace_ids()));

drop policy if exists "Analytics by agency" on analytics_metrics;
alter table analytics_metrics enable row level security;
drop policy if exists "Analytics by access" on analytics_metrics;
create policy "Analytics by access" on analytics_metrics
  for all using (workspace_id in (select user_workspace_ids()));

drop policy if exists "Site pages by agency" on site_pages;
alter table site_pages enable row level security;
drop policy if exists "Site pages by access" on site_pages;
create policy "Site pages by access" on site_pages
  for all using (workspace_id in (select user_workspace_ids()));

drop policy if exists "Output settings by agency" on workspace_output_settings;
alter table workspace_output_settings enable row level security;
drop policy if exists "Output settings by access" on workspace_output_settings;
create policy "Output settings by access" on workspace_output_settings
  for all using (workspace_id in (select user_workspace_ids()));

-- --- grandchildren: reached through keywords / articles -------------------

drop policy if exists "Keyword rankings by agency" on keyword_rankings;
alter table keyword_rankings enable row level security;
drop policy if exists "Keyword rankings by access" on keyword_rankings;
create policy "Keyword rankings by access" on keyword_rankings
  for all using (
    keyword_id in (select id from keywords where workspace_id in (select user_workspace_ids()))
  );

drop policy if exists "SEO audits by agency" on seo_audits;
alter table seo_audits enable row level security;
drop policy if exists "SEO audits by access" on seo_audits;
create policy "SEO audits by access" on seo_audits
  for all using (
    article_id in (select id from articles where workspace_id in (select user_workspace_ids()))
  );

-- --- invites: only owners and admins may create or revoke them ------------
--
-- 011 let any member insert an invite, so the server action's role check was
-- the only thing standing between an editor and the invite table. The Team
-- page now states that editors cannot invite; the database should agree.
-- Reading stays open to every member (they see the pending list). Accepting
-- an invite runs through the service role, since the invitee is not yet a
-- member and no member policy could ever admit them.

drop policy if exists "Agency members create invites" on invites;
alter table invites enable row level security;
drop policy if exists "Admins create invites" on invites;
create policy "Admins create invites" on invites
  for insert with check (agency_id in (select user_admin_agency_ids()));

drop policy if exists "Agency members update invites" on invites;
drop policy if exists "Admins update invites" on invites;
create policy "Admins update invites" on invites
  for update using (agency_id in (select user_admin_agency_ids()));

drop policy if exists "Agency members delete invites" on invites;
alter table invites enable row level security;
drop policy if exists "Admins delete invites" on invites;
create policy "Admins delete invites" on invites
  for delete using (agency_id in (select user_admin_agency_ids()));

-- ============================================================
-- 2. Pause instead of cancel
-- ============================================================
--
-- `workspaces.status = 'paused'` already stops the generate, analyze and
-- site-pages crons (each filters `.neq("status", "paused")`). What was missing
-- is *until when*: a pause with no end is a cancel that forgot to say so.
-- Set by the pause action on every workspace of the agency, cleared on
-- resume. NULL on a paused row means someone paused it by hand, indefinitely,
-- and resume leaves those alone.

alter table workspaces
  add column if not exists paused_until date;

comment on column workspaces.paused_until is
  'Set with status=paused by the account pause on Billing. NULL on a paused row = paused by hand, no end date.';

-- When the subscription is set to end. Written by the cancel action and kept
-- in step by the Stripe webhook (`cancel_at`). NULL = not ending. Kept apart
-- from plan_status because the plan is still active until this date, and the
-- page has to say both things.
alter table agencies
  add column if not exists cancels_at timestamptz;

comment on column agencies.cancels_at is
  'Period end at which the subscription stops, when cancel-at-period-end is set. NULL = renewing.';

-- ============================================================
-- 3. Why they left
-- ============================================================
--
-- One row per cancellation, written before the subscription is touched. The
-- reason is one of a fixed list so it can be counted; `detail` is the free
-- text for "Other" and for anyone who wants to say more.

create table if not exists cancellation_feedback (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  reason text not null check (reason in (
    'quality',      -- Article quality doesn't meet my standards
    'no_results',   -- Not seeing results
    'price',        -- Too expensive for what I get
    'switched',     -- Switched to another tool
    'no_need',      -- Don't need it anymore
    'other'
  )),
  detail text,
  plan text,
  created_at timestamptz not null default now()
);

create index if not exists idx_cancellation_feedback_agency
  on cancellation_feedback (agency_id, created_at desc);

-- Owners and admins write it (cancelling is owner-only in the action; the
-- policy is one notch wider so an admin reading the page does not hit an
-- opaque error). Members of the agency may read their own account's rows.
drop policy if exists "Admins record cancellation feedback" on cancellation_feedback;
create policy "Admins record cancellation feedback" on cancellation_feedback
  for insert with check (agency_id in (select user_admin_agency_ids()));

alter table cancellation_feedback enable row level security;
drop policy if exists "Members read own cancellation feedback" on cancellation_feedback;
create policy "Members read own cancellation feedback" on cancellation_feedback
  for select using (agency_id in (select user_agency_ids()));
