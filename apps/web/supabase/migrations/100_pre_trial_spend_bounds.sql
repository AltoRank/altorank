-- 100: what bounds an account's spend before its trial is written by the server
-- Depends on: 076_onboarding_runs, 085_agencies_to_accounts (accounts,
-- account_members, the renamed RLS helpers), 053/072 (the workspace policies),
-- 093_draft_claims (workspaces.trial_resume_*).
-- Apply AFTER its code is live on production, like 097 and 099: see
-- RUNBOOK.md. Code from before it inserts workspaces through the person's own
-- client, and with this applied "Add workspace" fails for everyone; the code
-- that ships with it writes the row with the service role and works with or
-- without this file.
--
-- An account that has not started its trial gets one article and nothing
-- else bought for it (apps/web/lib/billing/trial-hold.ts). The app now counts
-- the ATTEMPT - the pre-trial draft is claimed on the server-written
-- `accounts.free_drafts_used` before anything is bought, and setup runs are
-- counted from `onboarding_runs` - so what a client token can still write
-- must not reset or multiply those counts. Four ways it could:
--
-- 1. onboarding_runs died with their site. The rows cascade on the workspace,
--    and an owner may delete a site, so deleting a site and adding it again
--    handed back the account's setup runs, and each run buys the site read
--    and the keyword research again (about $0.22). A run now outlives its
--    site (`workspace_id` set null): the account's count stays true, and a
--    run whose site is gone is simply not shown anywhere, since every read
--    of a run goes by workspace or by id.
--
-- 2. INSERT on workspaces. The insert policy let an owner POST any number of
--    rows straight to /rest/v1/workspaces, past the one-site allowance, the
--    domain check and the duplicate check that createWorkspace makes (a
--    reviewer inserted 20). Sites are now inserted by the server only
--    (apps/web/lib/workspaces/insert.ts, which makes the policy's own check
--    before it writes); signup already did.
--
-- 3. Columns of workspaces no client writes. `ai_provider` and `ai_model` are
--    read straight into the model call, and pointing them at a model that
--    does not exist made every draft fail after its research was bought.
--    `account_id` moves a site, and everything under it, between accounts.
--    `trial_resume_*` are the resume's claim (093). No code writes any of
--    them through a person's client, so a client token loses UPDATE on them;
--    every other column keeps it.
--
-- 4. A person's own membership. "Owners manage members" is FOR ALL, so an
--    owner could delete their own account_members row (or point it at
--    another user), and the next page load's ensureAccount made them a fresh
--    account: no plan, never trialed, its one pre-trial article unspent - as
--    many times as they liked, keeping the old ones by inviting themselves
--    back. The app never edits a member's own row (canEditMember refuses
--    it), so a trigger refuses it to a signed-in user: removing someone is
--    always somebody else's action.
--
-- Idempotent: every statement is guarded or replaces what it names.
-- Rollback in RUNBOOK.md.

-- 1 ---------------------------------------------------------------------------

alter table public.onboarding_runs alter column workspace_id drop not null;
alter table public.onboarding_runs drop constraint if exists onboarding_runs_workspace_id_fkey;
alter table public.onboarding_runs
  add constraint onboarding_runs_workspace_id_fkey
  foreign key (workspace_id) references public.workspaces(id) on delete set null;

-- The spend gate counts an account's runs (setupRunsStarted).
create index if not exists idx_onboarding_runs_account on public.onboarding_runs (account_id);

comment on column public.onboarding_runs.workspace_id is
  'The site the run set up. Null once that site is deleted: the run is kept, because the account''s setup runs before its trial are counted from this table (migration 100).';

-- 2 ---------------------------------------------------------------------------

revoke insert on table public.workspaces from anon, authenticated;
grant insert on table public.workspaces to service_role;

-- 3 ---------------------------------------------------------------------------
-- Same pattern as 097: take the table-level privilege away, then grant back
-- every column but the listed ones. A column added to `workspaces` later is
-- NOT writable by a client token until its migration grants it:
--   grant update (<column>) on public.workspaces to authenticated;

revoke update on table public.workspaces from anon, authenticated;

do $$
declare
  writable text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into writable
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'workspaces'
     and column_name not in ('id', 'account_id', 'ai_provider', 'ai_model',
                             'trial_resume_key', 'trial_resume_claimed_at', 'trial_resumed_at');
  execute format('grant update (%s) on table public.workspaces to authenticated', writable);
end
$$;

grant update on table public.workspaces to service_role;

-- 4 ---------------------------------------------------------------------------

-- caller: internal (trigger only - see the REVOKE below)
create or replace function public.account_members_guard_own_row()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if pg_trigger_depth() = 0 then
    raise exception 'account_members_guard_own_row is a trigger function'
      using errcode = '42501';
  end if;

  -- The service role and psql: the server removes members, and a cascade
  -- from a deleted account or user passes here too.
  if auth.uid() is null then
    return coalesce(new, old);
  end if;

  if old.user_id = auth.uid()
     and (tg_op = 'DELETE'
          or new.user_id is distinct from old.user_id
          or new.account_id is distinct from old.account_id)
  then
    raise exception 'A member cannot remove or move their own membership; another owner or admin removes them'
      using errcode = '42501';
  end if;

  return coalesce(new, old);
end;
$$;

revoke execute on function public.account_members_guard_own_row() from public, anon, authenticated;

drop trigger if exists account_members_guard_own_row on public.account_members;
create trigger account_members_guard_own_row
  before update or delete on public.account_members
  for each row execute function public.account_members_guard_own_row();
