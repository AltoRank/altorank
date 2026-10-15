-- 111: a member limited to some sites acts within them, and a site's Google connection is written by the server
-- Depends on: 033 (account_integrations, as agency_integrations), 051 (api_keys),
-- 053 (account_members.workspace_ids), 085 (the renames), 099 (api_keys
-- written by the service role), 102 (account_members_guard_roles and
-- invites_guard_scope, both replaced here). 110 is not a dependency.
-- Apply AFTER its code is live: see RUNBOOK.md. The code from the same
-- change reads the account's Google consent and writes a site's Google
-- connection with the service role, which this file leaves untouched; code
-- from before it wrote those through the person's own client.
--
-- `account_members.workspace_ids` limits a member to some sites (NULL is every
-- site). Five things decide how far such a member reaches, and this holds the
-- database to the same rule as the app (apps/web/lib/team/access.ts):
--
-- 1. Membership edits. 102's guard stops a member editing their own row and a
--    non-owner touching an owner. It now also stops a member limited to some
--    sites from giving anyone NULL, an empty list or a site outside their
--    own, from taking away a site of someone else's that they do not hold,
--    and from changing the role of, or removing, a member whose sites reach
--    past their own.
-- 2. Invites. 102's invite guard let an OWNER limited to some sites invite to
--    every site; the rule is now the same for every role, names at least one
--    site, and covers changing and revoking an invite as well as making one.
-- 3. API keys. A key acts for the whole account (the agent API and hosted MCP
--    resolve it to an account, not to sites), so a key row whose creator is
--    limited to some sites is refused. This binds the service role too: it is
--    a property of the row, not of who writes it.
-- 4. Google. The account's consent ciphertext (`account_integrations.tokens`)
--    is no longer readable by a signed-in client, and a signed-in client may
--    not insert a Search Console or Analytics row on a site or change one's
--    token, property or integration. The server writes those after checking
--    the site (apps/web/app/actions/google-properties.ts, the OAuth callback,
--    lib/google/sync.ts). Marking a row for reconnect and deleting it are
--    unchanged.
-- 5. Domains. Those connections are matched to a site's domain, so a member
--    limited to some sites does not change one.
--
-- Each guard passes the service role (no `auth.uid()`) and the database's own
-- cascades (`pg_trigger_depth() > 1`), like 099-109, except the api_keys one,
-- which every writer meets.
--
-- Idempotent: create or replace, drop-then-create for every trigger, and the
-- grants are re-stated. Rollback in RUNBOOK.md.

-- 1 ---------------------------------------------------------------------------

-- caller: internal (trigger only - see the REVOKE below)
create or replace function public.account_members_guard_roles()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  actor_is_owner boolean;
  actor_sites uuid[];
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

  select m.workspace_ids into actor_sites
    from account_members m
   where m.account_id = old.account_id and m.user_id = auth.uid();

  -- Removing someone is the widest change to their access: a member limited
  -- to some sites removes only members within them. Leaving is 100's.
  if tg_op = 'DELETE' then
    if actor_sites is not null and old.user_id is distinct from auth.uid()
       and (old.workspace_ids is null or not (old.workspace_ids <@ actor_sites))
    then
      raise exception 'A member limited to some sites cannot remove a member with sites they do not have'
        using errcode = '42501';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    -- A member limited to some sites acts within them.
    if actor_sites is not null then
      if new.workspace_ids is distinct from old.workspace_ids then
        if old.workspace_ids is null or new.workspace_ids is null then
          raise exception 'A member limited to some sites cannot give or change access to every site'
            using errcode = '42501';
        end if;
        if cardinality(new.workspace_ids) = 0 then
          raise exception 'A member limited to some sites leaves a member at least one site'
            using errcode = '42501';
        end if;
        if not (new.workspace_ids <@ (actor_sites || old.workspace_ids)) then
          raise exception 'A member limited to some sites cannot give access to sites they do not have'
            using errcode = '42501';
        end if;
        if exists (
          select 1 from unnest(old.workspace_ids) s
           where not (s = any (actor_sites)) and not (s = any (new.workspace_ids))
        ) then
          raise exception 'A member limited to some sites cannot take away sites they do not have'
            using errcode = '42501';
        end if;
      end if;

      if new.role is distinct from old.role
         and (old.workspace_ids is null or not (old.workspace_ids <@ actor_sites))
      then
        raise exception 'A member limited to some sites cannot change the role of a member with sites they do not have'
          using errcode = '42501';
      end if;
    end if;
  end if;

  return coalesce(new, old);
end;
$$;

revoke execute on function public.account_members_guard_roles() from public, anon, authenticated;

drop trigger if exists account_members_guard_roles on public.account_members;
create trigger account_members_guard_roles
  before update or delete on public.account_members
  for each row execute function public.account_members_guard_roles();

-- 2 ---------------------------------------------------------------------------

create or replace function public.invites_guard_scope()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_sites uuid[];
begin
  -- The server writes invites it has checked; a cascade is not a person.
  if auth.uid() is null or pg_trigger_depth() > 1 then
    return coalesce(new, old);
  end if;

  if tg_op in ('INSERT', 'UPDATE') and new.role = 'owner' then
    raise exception 'An invite cannot make an owner; invite an admin, then make them owner on the Team page'
      using errcode = '42501';
  end if;

  -- A member with every site invites to any sites. A member limited to some,
  -- whatever their role, only within their own: NULL (every site) is wider
  -- than any list, each listed site must be theirs, and the list names at
  -- least one. Changing or revoking an invite is held to the same reach as
  -- making it, for the invite as it was (on its account) as well as as it
  -- becomes.
  if tg_op in ('UPDATE', 'DELETE') then
    select m.workspace_ids into actor_sites
      from account_members m
     where m.account_id = old.account_id and m.user_id = auth.uid();
    if actor_sites is not null
       and (old.workspace_ids is null or not (old.workspace_ids <@ actor_sites))
    then
      raise exception 'An invite cannot reach sites the inviter does not have'
        using errcode = '42501';
    end if;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    select m.workspace_ids into actor_sites
      from account_members m
     where m.account_id = new.account_id and m.user_id = auth.uid();
    if actor_sites is not null
       and (new.workspace_ids is null or cardinality(new.workspace_ids) = 0
            or not (new.workspace_ids <@ actor_sites))
    then
      raise exception 'An invite cannot reach sites the inviter does not have'
        using errcode = '42501';
    end if;
  end if;

  return coalesce(new, old);
end;
$$;

revoke execute on function public.invites_guard_scope() from public, anon, authenticated;

drop trigger if exists invites_guard_scope on public.invites;
create trigger invites_guard_scope
  before insert or update or delete on public.invites
  for each row execute function public.invites_guard_scope();

-- 3 ---------------------------------------------------------------------------

-- caller: internal (trigger only - see the REVOKE below)
create or replace function public.api_keys_creator_sees_every_site()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.created_by is not null and exists (
    select 1 from account_members m
     where m.account_id = new.account_id
       and m.user_id = new.created_by
       and m.workspace_ids is not null
  ) then
    raise exception 'An API key reaches every site on the account; its creator must have access to every site'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke execute on function public.api_keys_creator_sees_every_site() from public, anon, authenticated;

drop trigger if exists api_keys_creator_sees_every_site on public.api_keys;
create trigger api_keys_creator_sees_every_site
  before insert on public.api_keys
  for each row execute function public.api_keys_creator_sees_every_site();

-- 4 ---------------------------------------------------------------------------

-- The consent's ciphertext is the server's. Members keep seeing that a
-- connection exists (every other column), which is all 033 meant them to see.
revoke select on table public.account_integrations from anon, authenticated;
do $$
declare
  cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'account_integrations' and column_name <> 'tokens';
  execute format('grant select (%s) on table public.account_integrations to authenticated', cols);
end
$$;
grant select on table public.account_integrations to service_role;

-- caller: internal (trigger only - see the REVOKE below)
create or replace function public.workspace_integrations_google_server_written()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if pg_trigger_depth() = 0 then
    raise exception 'workspace_integrations_google_server_written is a trigger function'
      using errcode = '42501';
  end if;

  -- The server, psql, and a foreign key's own action.
  if auth.uid() is null or pg_trigger_depth() > 1 then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.integration_id in ('gsc', 'ga4') then
      raise exception 'A Google connection is written by the server'
        using errcode = '42501';
    end if;
  elsif (old.integration_id in ('gsc', 'ga4') or new.integration_id in ('gsc', 'ga4'))
        and (new.integration_id is distinct from old.integration_id
             or new.tokens is distinct from old.tokens
             or new.config is distinct from old.config)
  then
    raise exception 'A Google connection is written by the server'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke execute on function public.workspace_integrations_google_server_written() from public, anon, authenticated;

drop trigger if exists workspace_integrations_google_server_written on public.workspace_integrations;
create trigger workspace_integrations_google_server_written
  before insert or update on public.workspace_integrations
  for each row execute function public.workspace_integrations_google_server_written();

-- 5 ---------------------------------------------------------------------------

-- A site's Search Console, Analytics and Bing connections are matched to its
-- domain, with credentials that can see the account's other sites (the
-- account's Google consent, a Bing key used across clients). So the domain is
-- moved only by a member with every site, or by the server; a member limited
-- to some sites keeps the domain their sites were given. A change of case is
-- not a move.

-- caller: internal (trigger only - see the REVOKE below)
create or replace function public.workspaces_domain_needs_every_site()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if pg_trigger_depth() = 0 then
    raise exception 'workspaces_domain_needs_every_site is a trigger function'
      using errcode = '42501';
  end if;

  if auth.uid() is null or pg_trigger_depth() > 1 then
    return new;
  end if;

  if lower(new.domain) is distinct from lower(old.domain) and exists (
    select 1 from account_members m
     where m.account_id = old.account_id
       and m.user_id = auth.uid()
       and m.workspace_ids is not null
  ) then
    raise exception 'Only a member with access to every site can change a site''s domain'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke execute on function public.workspaces_domain_needs_every_site() from public, anon, authenticated;

drop trigger if exists workspaces_domain_needs_every_site on public.workspaces;
create trigger workspaces_domain_needs_every_site
  before update of domain on public.workspaces
  for each row execute function public.workspaces_domain_needs_every_site();
