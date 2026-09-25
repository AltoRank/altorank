-- 101: an account is ours because we made it, and memberships are written by the server
-- Depends on: 085_agencies_to_accounts (accounts, account_members, the renamed
-- RLS helpers). Independent of 097-100, which go in after the deploy.
-- Apply BEFORE its code is deployed: see RUNBOOK.md. The code that ships with
-- it reads `accounts.created_by`, and without the column every "is this our
-- own account?" question fails and our accounts are metered like customers'.
-- Code from before it is unaffected (it never reads the column, and it only
-- ever inserts memberships with the service role).
--
-- Whether an account is one of ours - unmetered in the crons, open at the
-- trial gate, no "Powered by" line on what it publishes - was inferred from
-- its members: if any member's address was an operator's, the account was.
-- Membership is the account owner's to give, so it was the owner's to grant:
--
-- 1. account_members INSERT. "Owners manage members" is FOR ALL, so an owner
--    could POST any user id into their own account over PostgREST, with no
--    invitation. Adding an operator's user id turned the account into an
--    operator account for every cron, the planner, the spend gate and the
--    publisher's body lock. Every membership the product makes is written
--    with the service role - signup, an accepted invitation, ensureAccount -
--    so a client token loses INSERT, and keeps UPDATE only on the two columns
--    the Team page edits (`role`, `workspace_ids`).
--
-- 2. Accepting an invitation. Even without (1), an operator who accepted an
--    invitation to help a customer made that customer's account "ours": its
--    drafting stopped being held for the trial and its publisher stopped
--    locking the text. An account is ours when an operator CREATED it, so the
--    creator is recorded - `accounts.created_by`, set once from the account's
--    first membership by a trigger (every path that makes an account writes
--    its owner's membership right after the row), backfilled from the oldest
--    membership, and guarded by a trigger so no signed-in user can change
--    it. apps/web/lib/billing/operator-account.ts asks only about it.
--
-- Idempotent: every statement is guarded or replaces what it names.
-- Rollback in RUNBOOK.md.

-- 2 ---------------------------------------------------------------------------

alter table public.accounts
  add column if not exists created_by uuid references auth.users(id) on delete set null;

comment on column public.accounts.created_by is
  'The user whose membership was the account''s first: whoever signed up with it, or the person ensureAccount made it for. Set by the trigger account_members_set_account_creator, never by a client. Operator accounts are the ones an operator created (migration 101).';

-- The oldest membership of each account that has none recorded. Runs once in
-- practice: afterwards the trigger fills the column for every new account.
update public.accounts a
   set created_by = first.user_id
  from (
    select distinct on (account_id) account_id, user_id
      from public.account_members
     order by account_id, created_at asc nulls last, id
  ) first
 where first.account_id = a.id
   and a.created_by is null;

-- caller: internal (trigger only - see the REVOKE below)
create or replace function public.account_members_set_account_creator()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if pg_trigger_depth() = 0 then
    raise exception 'account_members_set_account_creator is a trigger function'
      using errcode = '42501';
  end if;

  -- Only the account's FIRST membership names its creator. A later one - an
  -- accepted invitation, whoever it is for - never does.
  update accounts
     set created_by = new.user_id
   where id = new.account_id
     and created_by is null
     and not exists (
       select 1 from account_members m
        where m.account_id = new.account_id and m.id <> new.id
     );
  return new;
end;
$$;

revoke execute on function public.account_members_set_account_creator() from public, anon, authenticated;

drop trigger if exists account_members_set_account_creator on public.account_members;
create trigger account_members_set_account_creator
  after insert on public.account_members
  for each row execute function public.account_members_set_account_creator();

-- Nobody signed in may change it. A trigger of its own rather than one more
-- line in accounts_guard_privileged_columns: this file goes in BEFORE its
-- code is deployed and 099 AFTER, and 099 replaces that function whole.

-- caller: internal (trigger only - see the REVOKE below)
create or replace function public.accounts_guard_created_by()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if pg_trigger_depth() = 0 then
    raise exception 'accounts_guard_created_by is a trigger function'
      using errcode = '42501';
  end if;

  if auth.uid() is not null and new.created_by is distinct from old.created_by then
    raise exception 'Who created an account is recorded by AltoRank, not by a signed-in user'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke execute on function public.accounts_guard_created_by() from public, anon, authenticated;

drop trigger if exists accounts_guard_created_by on public.accounts;
create trigger accounts_guard_created_by
  before update on public.accounts
  for each row execute function public.accounts_guard_created_by();

-- 1 ---------------------------------------------------------------------------
-- DELETE stays with the policy (the Team page removes members through the
-- person's client) and with 100's trigger (never your own row).

revoke insert on table public.account_members from anon, authenticated;
revoke update on table public.account_members from anon, authenticated;
grant update (role, workspace_ids) on table public.account_members to authenticated;
grant insert, update on table public.account_members to service_role;
