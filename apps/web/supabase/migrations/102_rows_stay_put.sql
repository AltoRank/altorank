-- 102: a row stays in its site and its account, and a membership is changed only as the Team page allows
-- Depends on: 085_agencies_to_accounts (accounts, account_members and the
-- tables it renamed), 053_workspace_roles (the per-site policies). Nothing in
-- 097-101: it adds two triggers of its own and replaces no function, so it
-- can go in before or after any of them.
-- Apply any time, before or after its code is deployed: see RUNBOOK.md. No
-- code, old or new, does what either trigger refuses.
--
-- The trial gate decides by the ACCOUNT a row belongs to - an article's text
-- is withheld while the account that owns its site has not started its trial
-- (apps/web/lib/billing/body-lock.ts) - and two things a signed-in person
-- could write over PostgREST moved that answer:
--
-- 1. A row's site. The per-site policies are FOR ALL with a USING clause and
--    no separate WITH CHECK, and a client token keeps table UPDATE on
--    articles (097 took SELECT on the text columns, not writes). So somebody
--    who owns an account that has not started its trial and is also a member
--    of a paying account - even an editor of one site of it - could PATCH the
--    pre-trial article's `workspace_id` to the paying account's site and read
--    the whole text there, in the editor, the export and the publisher
--    (round-5 review, on an isolated copy of the schema). The same move takes
--    a calendar entry, a keyword or its research from one account to another.
--    No code moves a row between sites or accounts with a person's client, so
--    a trigger on every table that carries `workspace_id` or `account_id`
--    refuses a signed-in user changing either. Written generically (the row
--    read as jsonb, so one function serves tables that have one column or
--    both), and attached by a loop over the tables that have them.
--
-- 2. Roles. 101 left a client token UPDATE on `account_members.role` and
--    `workspace_ids` (what the Team page writes), and 100's trigger guards
--    only a member removing or moving their OWN row. So an admin could make
--    themselves owner, widen their own `workspace_ids` to every site, demote
--    the owner or delete the owner's membership - all of which the Team page
--    refuses (canEditMember in apps/web/lib/team/access.ts: nobody edits
--    themselves, owners are touched only by owners, only an owner makes an
--    owner). Deleting the owner also reopened the loop 100 closed: with no
--    membership left, the owner's next page load made them a fresh account
--    with its own pre-trial article. A second trigger now holds the database
--    to canEditMember, so an account always keeps an owner (only an owner can
--    remove or demote one, and nobody can remove or demote themselves).
--
-- Both pass the service role (no `auth.uid()`, which is how the server writes
-- memberships and everything else it writes) and a change the database makes
-- itself: a foreign key's `on delete set null` or `cascade`, which runs as a
-- trigger of its own (`pg_trigger_depth() > 1`), so deleting a site or an
-- account still works.
--
-- A table added later that carries `workspace_id` or `account_id` is not
-- covered until its migration attaches the trigger:
--   create trigger rows_stay_put before update on public.<table>
--     for each row execute function public.rows_stay_put();
--
-- Idempotent: create or replace, and drop-then-create for every trigger.
-- Rollback in RUNBOOK.md.

-- 1 ---------------------------------------------------------------------------

-- caller: internal (trigger only - see the REVOKE below)
create or replace function public.rows_stay_put()
returns trigger
language plpgsql
set search_path to 'public'
as $$
declare
  before_row jsonb;
  after_row jsonb;
begin
  if pg_trigger_depth() = 0 then
    raise exception 'rows_stay_put is a trigger function'
      using errcode = '42501';
  end if;

  -- The server, psql, and a foreign key's own action.
  if auth.uid() is null or pg_trigger_depth() > 1 then
    return new;
  end if;

  before_row := to_jsonb(old);
  after_row := to_jsonb(new);
  if (after_row -> 'workspace_id') is distinct from (before_row -> 'workspace_id')
     or (after_row -> 'account_id') is distinct from (before_row -> 'account_id')
  then
    raise exception 'A row stays in the site and account it was written in'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke execute on function public.rows_stay_put() from public, anon, authenticated;

do $$
declare
  t text;
begin
  for t in
    select distinct c.table_name
      from information_schema.columns c
      join information_schema.tables tb
        on tb.table_schema = c.table_schema and tb.table_name = c.table_name
     where c.table_schema = 'public'
       and tb.table_type = 'BASE TABLE'
       and c.column_name in ('workspace_id', 'account_id')
     order by c.table_name
  loop
    execute format('drop trigger if exists rows_stay_put on public.%I', t);
    execute format(
      'create trigger rows_stay_put before update on public.%I for each row execute function public.rows_stay_put()',
      t
    );
  end loop;
end
$$;

-- 2 ---------------------------------------------------------------------------

-- caller: internal (trigger only - see the REVOKE below)
-- Security definer to read the caller's own role in the account whatever the
-- member policies let them select; auth.uid() still names the caller.
create or replace function public.account_members_guard_roles()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  actor_is_owner boolean;
begin
  if pg_trigger_depth() = 0 then
    raise exception 'account_members_guard_roles is a trigger function'
      using errcode = '42501';
  end if;

  -- The server (invitations, signup, ensureAccount) and a cascade from a
  -- deleted account or user.
  if auth.uid() is null or pg_trigger_depth() > 1 then
    return coalesce(new, old);
  end if;

  -- Nobody edits themselves. Removing or moving one's own row is 100's
  -- trigger; this is the role and the sites.
  if tg_op = 'UPDATE' and old.user_id = auth.uid()
     and (new.role is distinct from old.role or new.workspace_ids is distinct from old.workspace_ids)
  then
    raise exception 'A member cannot change their own role or sites; another owner or admin changes them'
      using errcode = '42501';
  end if;

  select exists (
    select 1 from account_members m
     where m.account_id = old.account_id and m.user_id = auth.uid() and m.role = 'owner'
  ) into actor_is_owner;

  -- Owners are touched only by owners, and only an owner makes an owner.
  if not actor_is_owner
     and (old.role = 'owner' or (tg_op = 'UPDATE' and new.role = 'owner'))
  then
    raise exception 'Only an owner can change, remove or appoint an owner'
      using errcode = '42501';
  end if;

  return coalesce(new, old);
end;
$$;

revoke execute on function public.account_members_guard_roles() from public, anon, authenticated;

drop trigger if exists account_members_guard_roles on public.account_members;
create trigger account_members_guard_roles
  before update or delete on public.account_members
  for each row execute function public.account_members_guard_roles();
