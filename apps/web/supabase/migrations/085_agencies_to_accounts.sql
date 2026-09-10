-- 085: the account is an account, not an agency
-- Depends on: 001_initial_schema, 016 (user_admin_agency_ids), 053 (workspace
--             roles helpers), 072 (agencies_guard_privileged_columns trigger)
--
-- POSITIONING.md settled the ICP on 2026-08-30: agencies are one pricing tier,
-- not the customer. The dashboard's copy followed on 2026-09-07 (07a28d1,
-- workspace not site) and lib/types.ts has said "the entity is an account"
-- since. The schema never moved: `agencies` was still the account table,
-- `agency_id` the account key on every scoped table, `user_agency_ids()` the
-- RLS boundary, and `agency_members` the team. Every new table copied the
-- wrong noun because the catalogue taught it. The first customer who was not
-- an agency (a SaaS, 2026-09-09) is an "agency" with one workspace.
--
-- This renames the physical objects. `ALTER ... RENAME` keeps OIDs, so every
-- foreign key, policy expression, trigger binding, grant and dependent view
-- follows automatically; only what is stored as *text* has to be rewritten
-- by hand - the bodies of the `language sql` / `plpgsql` helper functions,
-- which name the tables and columns as strings. Those are re-issued below
-- with their new bodies, after being renamed in place so the policies that
-- reference them by OID keep working across the statement.
--
-- Catalogue-driven where the set is open-ended (every `agency_id` column,
-- every index / constraint / policy whose *name* carries the old noun), so
-- a column another branch added between this file being written and it
-- being applied is renamed too, and nothing is missed for being unlisted.
--
-- Nothing here touches the `plan` column: 'starter' / 'growth' / 'scale'
-- are values, and the growth tier's label "Agency" (lib/stripe.ts) is
-- product copy, not schema.
--
-- Idempotent: every step is guarded by "does the old name still exist".
-- Transactional (`-1`): PostgreSQL DDL is transactional, so a failure
-- leaves the old names in place.

-- --- 1. tables -----------------------------------------------------------

do $$
begin
  if to_regclass('public.agencies') is not null then
    alter table public.agencies rename to accounts;
  end if;
  if to_regclass('public.agency_members') is not null then
    alter table public.agency_members rename to account_members;
  end if;
  if to_regclass('public.agency_integrations') is not null then
    alter table public.agency_integrations rename to account_integrations;
  end if;
end $$;

-- --- 2. columns ----------------------------------------------------------
--
-- `agency_id` on every table, plus the two role-prefixed keys on
-- backlink_exchanges. `information_schema.columns` is read after the table
-- renames, so the new table names are what get altered.

do $$
declare
  r record;
begin
  for r in
    select table_name, column_name
    from information_schema.columns
    where table_schema = 'public'
      and column_name in ('agency_id', 'requester_agency_id', 'provider_agency_id')
  loop
    execute format(
      'alter table public.%I rename column %I to %I',
      r.table_name,
      r.column_name,
      replace(r.column_name, 'agency_id', 'account_id')
    );
  end loop;
end $$;

-- --- 3. helper functions -------------------------------------------------
--
-- Rename in place first (keeps the OID every RLS policy references), then
-- replace the body, which is stored as text and still says agency_members.
-- `create or replace` on the new name keeps that same OID.

do $$
begin
  if to_regprocedure('public.user_agency_ids()') is not null then
    alter function public.user_agency_ids() rename to user_account_ids;
  end if;
  if to_regprocedure('public.user_admin_agency_ids()') is not null then
    alter function public.user_admin_agency_ids() rename to user_admin_account_ids;
  end if;
  if to_regprocedure('public.user_full_access_agency_ids()') is not null then
    alter function public.user_full_access_agency_ids() rename to user_full_access_account_ids;
  end if;
  if to_regprocedure('public.agencies_guard_privileged_columns()') is not null then
    alter function public.agencies_guard_privileged_columns() rename to accounts_guard_privileged_columns;
  end if;
end $$;

-- caller: authenticated (001, body per 016)
create or replace function public.user_account_ids()
returns setof uuid
language sql
stable security definer
set search_path = public
as $$
  select account_id from account_members where user_id = auth.uid();
$$;

comment on function public.user_account_ids() is
  'Accounts the caller is a member of. The RLS predicate for every account-scoped table.';

-- caller: authenticated (016)
create or replace function public.user_admin_account_ids()
returns setof uuid
language sql
stable security definer
set search_path = public
as $$
  select account_id
  from account_members
  where user_id = auth.uid()
    and role in ('owner', 'admin');
$$;

comment on function public.user_admin_account_ids() is
  'Accounts where the caller is an owner or admin.';

-- caller: authenticated (053)
create or replace function public.user_workspace_ids()
returns setof uuid
language sql
stable security definer
set search_path = public
as $$
  select w.id
  from account_members m
  join workspaces w on w.account_id = m.account_id
  where m.user_id = auth.uid()
    and (m.workspace_ids is null or w.id = any (m.workspace_ids));
$$;

comment on function public.user_workspace_ids() is
  'Workspaces the caller may see: all of an account''s for a NULL membership, the listed ones otherwise. The RLS predicate for every workspace-scoped table.';

-- caller: authenticated (053). PostgreSQL will not rename a parameter through
-- `create or replace` ("cannot change name of input parameter"), and the
-- function cannot simply be dropped because the workspaces policies depend on
-- it by OID. So: save every policy whose expression calls it, drop them, drop
-- and recreate the function with the new parameter name, and recreate the
-- policies from their saved (already-renamed) expressions. All inside this
-- transaction, so RLS on workspaces is never observably off.
--
-- The same pass also catches a cosmetic leftover of renaming the other
-- helpers in place: a policy written as `id in (select user_agency_ids())`
-- deparses after the rename as `select user_account_ids() as user_agency_ids`
-- - the subquery's output column keeps the name it was parsed with. Harmless,
-- and `\d+ workspaces` would show the old noun for ever. So every policy
-- whose expression still says "agency" is recreated too, from its deparsed
-- text with the alias rewritten.
create temporary table if not exists _085_saved_policies on commit drop as
  select schemaname, tablename, policyname, permissive, roles, cmd,
    regexp_replace(qual, 'agenc(y|ies)', 'account\1', 'g') as qual,
    regexp_replace(with_check, 'agenc(y|ies)', 'account\1', 'g') as with_check
  from pg_policies
  where schemaname = 'public'
    and (qual ~* 'user_can_access_workspace|agenc' or with_check ~* 'user_can_access_workspace|agenc');

do $$
declare
  r record;
begin
  for r in select * from _085_saved_policies loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

drop function if exists public.user_can_access_workspace(uuid, uuid);

create function public.user_can_access_workspace(p_account_id uuid, p_workspace_id uuid)
returns boolean
language sql
stable security definer
set search_path = public
as $$
  select exists (
    select 1
    from account_members m
    where m.user_id = auth.uid()
      and m.account_id = p_account_id
      and (m.workspace_ids is null or p_workspace_id = any (m.workspace_ids))
  );
$$;

comment on function public.user_can_access_workspace(uuid, uuid) is
  'Per-row form of user_workspace_ids(), for the workspaces table itself.';

do $$
declare
  r record;
  sql text;
begin
  for r in select * from _085_saved_policies loop
    sql := format('create policy %I on %I.%I as %s for %s to %s',
      r.policyname, r.schemaname, r.tablename, r.permissive, r.cmd,
      array_to_string(array(select quote_ident(x) from unnest(r.roles) as x), ', '));
    if r.qual is not null then
      sql := sql || format(' using (%s)', r.qual);
    end if;
    if r.with_check is not null then
      sql := sql || format(' with check (%s)', r.with_check);
    end if;
    execute sql;
  end loop;
end $$;

-- caller: authenticated (053)
create or replace function public.user_full_access_account_ids()
returns setof uuid
language sql
stable security definer
set search_path = public
as $$
  select account_id from account_members
  where user_id = auth.uid() and workspace_ids is null;
$$;

comment on function public.user_full_access_account_ids() is
  'Accounts where the caller may see every workspace, so may add one.';

-- caller: internal (trigger only; 072). Same body, new nouns.
create or replace function public.accounts_guard_privileged_columns()
returns trigger
language plpgsql
set search_path to 'public'
as $$
declare
  is_admin boolean;
begin
  if pg_trigger_depth() = 0 then
    raise exception 'accounts_guard_privileged_columns is a trigger function'
      using errcode = '42501';
  end if;

  if auth.uid() is null then
    return new;
  end if;

  if (new.plan is distinct from old.plan)
     or (new.plan_status is distinct from old.plan_status)
     or (new.stripe_customer_id is distinct from old.stripe_customer_id)
     or (new.stripe_subscription_id is distinct from old.stripe_subscription_id)
     or (new.current_period_end is distinct from old.current_period_end)
     or (new.cancels_at is distinct from old.cancels_at)
     or (new.payment_failed_at is distinct from old.payment_failed_at)
     or (new.api_key is distinct from old.api_key)
  then
    raise exception 'Billing and API-key columns on an account are set by AltoRank, not by a signed-in user'
      using errcode = '42501';
  end if;

  select exists (
    select 1 from account_members m
    where m.user_id = auth.uid() and m.account_id = new.id and m.role in ('owner', 'admin')
  ) into is_admin;

  if not is_admin then
    if (new.name is distinct from old.name)
       or (new.slug is distinct from old.slug)
       or (new.logo_url is distinct from old.logo_url)
       or (new.custom_domain is distinct from old.custom_domain)
       or (new.accent_color is distinct from old.accent_color)
       or (new.remove_branding is distinct from old.remove_branding)
       or (new.report_email is distinct from old.report_email)
    then
      raise exception 'Only an owner or admin can change account settings'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.accounts_guard_privileged_columns() from public, anon, authenticated;

-- The trigger follows the table rename by OID; only its name is stale.
do $$
begin
  if exists (select 1 from pg_trigger where tgname = 'agencies_guard_privileged_columns' and not tgisinternal) then
    alter trigger agencies_guard_privileged_columns on public.accounts rename to accounts_guard_privileged_columns;
  end if;
end $$;

-- --- 4. names of indexes, constraints and policies -----------------------
--
-- Cosmetic, and worth doing: the next person who runs `\d accounts` should
-- not be told its primary key is `agencies_pkey`. Expressions are untouched
-- (they are stored by OID and already deparse with the new names); only the
-- identifier is rewritten. `agencies` -> `accounts`, `agency` -> `account`.

do $$
declare
  r record;
  new_name text;
begin
  -- constraints (their backing indexes are renamed with them)
  for r in
    select c.conname, c.conrelid::regclass as tbl
    from pg_constraint c
    join pg_namespace n on n.oid = c.connamespace
    where n.nspname = 'public' and c.conname ~ 'agenc'
  loop
    new_name := replace(replace(r.conname, 'agencies', 'accounts'), 'agency', 'account');
    execute format('alter table %s rename constraint %I to %I', r.tbl, r.conname, new_name);
  end loop;

  -- standalone indexes
  for r in
    select i.relname
    from pg_class i
    join pg_namespace n on n.oid = i.relnamespace
    where n.nspname = 'public' and i.relkind = 'i' and i.relname ~ 'agenc'
      and not exists (select 1 from pg_constraint c where c.conindid = i.oid)
  loop
    new_name := replace(replace(r.relname, 'agencies', 'accounts'), 'agency', 'account');
    execute format('alter index public.%I rename to %I', r.relname, new_name);
  end loop;

  -- policies: "Articles by agency" -> "Articles by account", and so on
  for r in
    select policyname, tablename
    from pg_policies
    where schemaname = 'public' and policyname ~* 'agenc'
  loop
    new_name := regexp_replace(
      regexp_replace(
        regexp_replace(regexp_replace(r.policyname, 'agencies', 'accounts', 'g'), 'Agencies', 'Accounts', 'g'),
        'agency', 'account', 'g'),
      'Agency', 'Account', 'g');
    execute format('alter policy %I on public.%I rename to %I', r.policyname, r.tablename, new_name);
  end loop;
end $$;

-- --- 5. comments ---------------------------------------------------------
--
-- Column and table comments are the catalogue's own documentation and the
-- thing `\d+` shows first. Rewrite the noun in every comment on a public
-- table or column that carries it; the text otherwise stays as written.

do $$
declare
  r record;
begin
  for r in
    select c.oid as relid, c.relname, d.objsubid, d.description
    from pg_description d
    join pg_class c on c.oid = d.objoid and d.classoid = 'pg_class'::regclass
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and d.description ~* 'agenc'
  loop
    if r.objsubid = 0 then
      execute format('comment on table public.%I is %L', r.relname,
        regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
          r.description,
          'agency_members', 'account_members', 'g'),
          'agency_id', 'account_id', 'g'),
          'agencies', 'accounts', 'g'),
          'agency', 'account', 'g'),
          'Agenc(y|ies)', 'Account\1', 'g'));
    else
      execute format('comment on column public.%I.%I is %L', r.relname,
        (select attname from pg_attribute where attrelid = r.relid and attnum = r.objsubid),
        regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
          r.description,
          'agency_members', 'account_members', 'g'),
          'agency_id', 'account_id', 'g'),
          'agencies', 'accounts', 'g'),
          'agency', 'account', 'g'),
          'Agenc(y|ies)', 'Account\1', 'g'));
    end if;
  end loop;
end $$;

comment on table public.accounts is
  'The account: the thing that signs up, pays, and owns workspaces. Named agencies until 085 (2026-09-09); an agency is now one plan tier, not the customer.';
comment on table public.account_members is
  'Who belongs to an account and with which role. workspace_ids NULL = every workspace of the account.';

-- --- 6. PostgREST --------------------------------------------------------
--
-- Supabase caches the schema; without this the API keeps answering for
-- `agencies` until the next restart and 404s `accounts`.
notify pgrst, 'reload schema';
