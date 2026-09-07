-- ---------------------------------------------------------------------------
-- 072 — least privilege on the agency-scoped tables
-- ---------------------------------------------------------------------------
--
-- Migration 053 made the workspace-scoped tables honour
-- `agency_members.workspace_ids`, so a member restricted to one site cannot
-- read or write another site's articles, keywords, calendar or metrics. The
-- agency-scoped tables were left as they were: `agency_id in
-- (select user_agency_ids())`, FOR ALL, for every member whatever their role.
--
-- Proved against two seeded tenants on 2026-09-06, signed in as an editor
-- restricted to one workspace of agency A. Through PostgREST — the same
-- anon-key endpoint the browser holds — that editor could:
--
--   * INSERT a row into `api_keys` for the whole agency, choosing the hash, so
--     minting themselves an `altorank_live_…` key with read+generate+write
--     scope. The agent API resolves a key to an agency and does not narrow to
--     a workspace, so that key reads and mutates EVERY site in the account,
--     including the ones the member was explicitly kept out of. It also
--     survives their removal from the team. Straight past both boundaries.
--   * UPDATE any existing key: revoke a colleague's, widen its scopes, or push
--     out its expiry.
--   * UPDATE `agencies` — `plan`, `plan_status`, `current_period_end` — which
--     is the paid-plan gate (lib/billing/quota.ts reads exactly these), so any
--     member could grant the account an unlimited plan without Stripe. The
--     same row carries `api_key`, the legacy plaintext blog key
--     (lib/blog-api/auth.ts), which they could read and also overwrite.
--   * INSERT `backlink_credits`, minting exchange credits that are only ever
--     supposed to be earned by publishing somebody else's article.
--   * SELECT `invites`, which carries the raw invite `token`.
--   * DELETE a workspace, cascading away its articles, keywords and history.
--
-- The fix is role, not visibility: members keep reading what the dashboard
-- shows them, and the privileged verbs move to owner/admin — or, for credits,
-- to the service role that settles an exchange. `agencies` keeps its
-- member-wide UPDATE so the signup attribution answer still writes, and a
-- trigger guards the columns that matter instead of the whole row.

-- --- api_keys: an agency-wide credential is an admin object -----------------

drop policy if exists "API keys by agency" on api_keys;

-- Everyone in the account still sees that keys exist (the Settings list has
-- always been readable to editors, and it never selects key_hash).
create policy "API keys visible to agency members"
  on api_keys for select
  using (agency_id in (select user_agency_ids()));

create policy "Admins create API keys"
  on api_keys for insert
  with check (agency_id in (select user_admin_agency_ids()));

create policy "Admins update API keys"
  on api_keys for update
  using (agency_id in (select user_admin_agency_ids()))
  with check (agency_id in (select user_admin_agency_ids()));

create policy "Admins delete API keys"
  on api_keys for delete
  using (agency_id in (select user_admin_agency_ids()));

-- --- backlink_credits: the ledger is settled by the server, never by a client

-- recordCredit (lib/seo/exchange.ts) is only ever called with the service
-- client, from settleExchangeForArticle after a publish. Nothing in the
-- product inserts a credit as the signed-in user, so nothing loses a
-- capability here; what goes away is a member writing their own balance.
drop policy if exists "Credits insert scoped to agency" on backlink_credits;

-- --- invites: the token is a credential ------------------------------------

-- The row carries the raw token that /invite/[token] accepts. Acceptance is
-- bound to the invited email address, so reading one is not by itself an
-- escalation, but a pending invite list with live tokens has no business
-- being readable by every member. Admins are who the Team page offers the
-- invite controls to anyway.
drop policy if exists "Invites visible to agency members" on invites;

create policy "Invites visible to agency admins"
  on invites for select
  using (agency_id in (select user_admin_agency_ids()));

-- --- workspaces: deleting a site is an admin action -------------------------

drop policy if exists "Workspaces deleted by access" on workspaces;

create policy "Workspaces deleted by admins"
  on workspaces for delete
  using (
    agency_id in (select user_admin_agency_ids())
    and user_can_access_workspace(agency_id, id)
  );

-- --- agencies: guard the columns, not the row -------------------------------

-- Members may still answer the attribution question on their own account
-- (app/actions/attribution.ts runs as the signed-in user with no role gate).
-- Everything that decides money, branding or account identity now needs an
-- owner or an admin, and the billing columns need the service role: Stripe's
-- webhook writes them (app/api/webhooks/stripe/route.ts) and nothing signed in
-- ever should.
--
-- SECURITY INVOKER on purpose. The membership lookup needs no elevation: a
-- member can already read their own agency_members row, and the service role
-- and psql bypass RLS anyway — where `auth.uid()` is null and the guard steps
-- aside on its first statement.

-- caller: internal (trigger only — see the REVOKE below)
create or replace function public.agencies_guard_privileged_columns()
returns trigger
language plpgsql
set search_path to 'public'
as $$
declare
  is_admin boolean;
begin
  -- Only ever reached from the BEFORE UPDATE trigger on agencies.
  if pg_trigger_depth() = 0 then
    raise exception 'agencies_guard_privileged_columns is a trigger function'
      using errcode = '42501';
  end if;

  -- The service role, the cron and psql are not a signed-in user; they own the
  -- billing columns and are left alone.
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
    raise exception 'Billing and API-key columns on an agency are set by AltoRank, not by a signed-in user'
      using errcode = '42501';
  end if;

  select exists (
    select 1 from agency_members m
    where m.user_id = auth.uid() and m.agency_id = new.id and m.role in ('owner', 'admin')
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

revoke execute on function public.agencies_guard_privileged_columns() from public, anon, authenticated;

drop trigger if exists agencies_guard_privileged_columns on agencies;
create trigger agencies_guard_privileged_columns
  before update on agencies
  for each row execute function public.agencies_guard_privileged_columns();
