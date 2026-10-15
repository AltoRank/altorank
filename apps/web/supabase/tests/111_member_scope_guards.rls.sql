-- Check for migration 111, run by hand against a database that has
-- migrations up to 111 applied (an isolated copy is best: this file writes
-- nothing that survives it, but it does write inside its transaction).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/111_member_scope_guards.rls.sql
--
-- Self-contained: it seeds six invented users, two accounts, three sites, an
-- invite and a few connections inside one transaction, checks every case, and rolls
-- back. A case that does not behave raises, so ON_ERROR_STOP turns it into a
-- non-zero exit; a green run ends with "111: all cases passed". auth.uid() is
-- simulated with request.jwt.claims, as PostgREST sets it.

begin;

insert into auth.users (id, email, instance_id, aud, role) values
  ('00000000-0000-4000-8000-0000000111a1', 'owner@acme-agency.example', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000111a2', 'site-admin@acme-agency.example', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000111a3', 'site-editor@acme-agency.example', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000111a4', 'two-sites@acme-agency.example', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000111a5', 'every-site@acme-agency.example', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000111a6', 'site-owner@acme-agency.example', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');

insert into accounts (id, name, slug, plan, plan_status) values
  ('00000000-0000-4000-8000-00000000111a', 'Acme', 'rls-111-acme', 'agency', 'active');
insert into workspaces (id, account_id, name, domain) values
  ('00000000-0000-4000-8000-0000000111c1', '00000000-0000-4000-8000-00000000111a', 'client one', 'one.acme-agency.example'),
  ('00000000-0000-4000-8000-0000000111c2', '00000000-0000-4000-8000-00000000111a', 'client two', 'two.acme-agency.example'),
  ('00000000-0000-4000-8000-0000000111c3', '00000000-0000-4000-8000-00000000111a', 'client three', 'three.acme-agency.example');
-- a2 is an admin of client one only; a3 an editor of client one; a4 an
-- editor of clients one and two; a5 an editor of every site; a6 an owner
-- limited to client one.
insert into account_members (account_id, user_id, role, workspace_ids) values
  ('00000000-0000-4000-8000-00000000111a', '00000000-0000-4000-8000-0000000111a1', 'owner', null),
  ('00000000-0000-4000-8000-00000000111a', '00000000-0000-4000-8000-0000000111a2', 'admin', array['00000000-0000-4000-8000-0000000111c1']::uuid[]),
  ('00000000-0000-4000-8000-00000000111a', '00000000-0000-4000-8000-0000000111a3', 'editor', array['00000000-0000-4000-8000-0000000111c1']::uuid[]),
  ('00000000-0000-4000-8000-00000000111a', '00000000-0000-4000-8000-0000000111a4', 'editor', array['00000000-0000-4000-8000-0000000111c1', '00000000-0000-4000-8000-0000000111c2']::uuid[]),
  ('00000000-0000-4000-8000-00000000111a', '00000000-0000-4000-8000-0000000111a5', 'editor', null),
  ('00000000-0000-4000-8000-00000000111a', '00000000-0000-4000-8000-0000000111a6', 'owner', array['00000000-0000-4000-8000-0000000111c1']::uuid[]);

-- A second account where the admin limited on Acme has every site.
insert into accounts (id, name, slug, plan, plan_status) values
  ('00000000-0000-4000-8000-00000000111b', 'Other', 'rls-111-other', 'agency', 'active');
insert into account_members (account_id, user_id, role, workspace_ids) values
  ('00000000-0000-4000-8000-00000000111b', '00000000-0000-4000-8000-0000000111a2', 'admin', null);

insert into invites (id, account_id, email, role, workspace_ids, token, expires_at) values
  ('00000000-0000-4000-8000-0000000111f1', '00000000-0000-4000-8000-00000000111a', 'pending-wide@acme-agency.example', 'editor', null, 'rls-111-seed', now() + interval '7 days');

insert into account_integrations (account_id, provider, tokens) values
  ('00000000-0000-4000-8000-00000000111a', 'google', '{"encrypted":"account-consent"}');
insert into workspace_integrations (id, workspace_id, integration_id, config, tokens) values
  ('00000000-0000-4000-8000-0000000111e1', '00000000-0000-4000-8000-0000000111c1', 'gsc', '{"type":"gsc","gscSiteUrl":"sc-domain:one.acme-agency.example"}', '{"encrypted":"account-consent"}'),
  ('00000000-0000-4000-8000-0000000111e2', '00000000-0000-4000-8000-0000000111c1', 'bing', '{"type":"bing"}', '{"encrypted":"bing-key"}');

create function pg_temp.expect_refused(label text, stmt text) returns void language plpgsql as $$
begin
  begin
    execute stmt;
  exception when insufficient_privilege then
    raise notice 'ok   refused: %', label;
    return;
  end;
  raise exception 'FAIL %: was allowed', label;
end $$;

create function pg_temp.expect_rows(label text, stmt text, n int) returns void language plpgsql as $$
declare
  got int;
begin
  execute stmt;
  get diagnostics got = row_count;
  if got <> n then raise exception 'FAIL %: % rows, expected %', label, got, n; end if;
  raise notice 'ok   allowed: %', label;
end $$;

grant execute on function pg_temp.expect_refused(text, text), pg_temp.expect_rows(text, text, int) to authenticated;

-- --- The admin limited to client one, over PostgREST -------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000111a2","role":"authenticated"}', true);

select pg_temp.expect_refused('give a member every site',
  $q$update account_members set workspace_ids = null where user_id = '00000000-0000-4000-8000-0000000111a3'$q$);
select pg_temp.expect_refused('give a member a site the actor does not have',
  $q$update account_members set workspace_ids = array['00000000-0000-4000-8000-0000000111c1', '00000000-0000-4000-8000-0000000111c3']::uuid[] where user_id = '00000000-0000-4000-8000-0000000111a3'$q$);
select pg_temp.expect_refused('take away a site the actor does not have',
  $q$update account_members set workspace_ids = array['00000000-0000-4000-8000-0000000111c1']::uuid[] where user_id = '00000000-0000-4000-8000-0000000111a4'$q$);
select pg_temp.expect_refused('narrow a member with every site',
  $q$update account_members set workspace_ids = array['00000000-0000-4000-8000-0000000111c1']::uuid[] where user_id = '00000000-0000-4000-8000-0000000111a5'$q$);
select pg_temp.expect_refused('change the role of a member with more sites',
  $q$update account_members set role = 'admin' where user_id = '00000000-0000-4000-8000-0000000111a4'$q$);
select pg_temp.expect_refused('change the role of a member with every site',
  $q$update account_members set role = 'admin' where user_id = '00000000-0000-4000-8000-0000000111a5'$q$);
select pg_temp.expect_refused('widen their own sites (102, unchanged)',
  $q$update account_members set workspace_ids = null where user_id = '00000000-0000-4000-8000-0000000111a2'$q$);
select pg_temp.expect_refused('invite to every site',
  $q$insert into invites (account_id, email, role, workspace_ids, token, expires_at) values ('00000000-0000-4000-8000-00000000111a', 'new@acme-agency.example', 'editor', null, 'rls-111-t1', now() + interval '7 days')$q$);
select pg_temp.expect_refused('invite to a site the actor does not have',
  $q$insert into invites (account_id, email, role, workspace_ids, token, expires_at) values ('00000000-0000-4000-8000-00000000111a', 'new@acme-agency.example', 'editor', array['00000000-0000-4000-8000-0000000111c2']::uuid[], 'rls-111-t2', now() + interval '7 days')$q$);
select pg_temp.expect_refused('read the account Google consent',
  $q$select tokens from account_integrations$q$);
select pg_temp.expect_refused('add a Search Console row',
  $q$insert into workspace_integrations (workspace_id, integration_id, config, tokens) values ('00000000-0000-4000-8000-0000000111c1', 'ga4', '{"type":"ga4","ga4PropertyId":"1"}', '{"encrypted":"account-consent"}')$q$);
select pg_temp.expect_refused('point the Search Console row at another property',
  $q$update workspace_integrations set config = '{"type":"gsc","gscSiteUrl":"sc-domain:two.acme-agency.example"}' where id = '00000000-0000-4000-8000-0000000111e1'$q$);
select pg_temp.expect_refused('replace the Search Console token',
  $q$update workspace_integrations set tokens = '{"encrypted":"other"}' where id = '00000000-0000-4000-8000-0000000111e1'$q$);
select pg_temp.expect_refused('turn another connection into a Google one',
  $q$update workspace_integrations set integration_id = 'ga4' where id = '00000000-0000-4000-8000-0000000111e2'$q$);

select pg_temp.expect_refused('remove a member with more sites',
  $q$delete from account_members where user_id = '00000000-0000-4000-8000-0000000111a4'$q$);
select pg_temp.expect_refused('remove a member with every site',
  $q$delete from account_members where user_id = '00000000-0000-4000-8000-0000000111a5'$q$);
select pg_temp.expect_refused('leave a member with an empty site list',
  $q$update account_members set workspace_ids = '{}'::uuid[] where user_id = '00000000-0000-4000-8000-0000000111a3'$q$);
select pg_temp.expect_refused('invite with an empty site list',
  $q$insert into invites (account_id, email, role, workspace_ids, token, expires_at) values ('00000000-0000-4000-8000-00000000111a', 'new@acme-agency.example', 'editor', '{}'::uuid[], 'rls-111-t6', now() + interval '7 days')$q$);
select pg_temp.expect_refused('revoke an invite to every site',
  $q$delete from invites where id = '00000000-0000-4000-8000-0000000111f1'$q$);
select pg_temp.expect_refused('narrow an invite to every site',
  $q$update invites set workspace_ids = array['00000000-0000-4000-8000-0000000111c1']::uuid[] where id = '00000000-0000-4000-8000-0000000111f1'$q$);
select pg_temp.expect_refused('move an invite to every site to an account where the actor has every site',
  $q$update invites set account_id = '00000000-0000-4000-8000-00000000111b' where id = '00000000-0000-4000-8000-0000000111f1'$q$);
select pg_temp.expect_refused('give a member a list with an unknown entry',
  $q$update account_members set workspace_ids = array['00000000-0000-4000-8000-0000000111c1', null]::uuid[] where user_id = '00000000-0000-4000-8000-0000000111a3'$q$);
select pg_temp.expect_refused('change a site''s domain',
  $q$update workspaces set domain = 'x.two.acme-agency.example' where id = '00000000-0000-4000-8000-0000000111c1'$q$);

select pg_temp.expect_rows('promote a member inside the actor''s sites',
  $q$update account_members set role = 'admin' where user_id = '00000000-0000-4000-8000-0000000111a3'$q$, 1);
select pg_temp.expect_rows('change the actor''s part of a member''s sites, keeping the rest',
  $q$update account_members set workspace_ids = array['00000000-0000-4000-8000-0000000111c2']::uuid[] where user_id = '00000000-0000-4000-8000-0000000111a4'$q$, 1);
select pg_temp.expect_rows('invite to the actor''s own site',
  $q$insert into invites (account_id, email, role, workspace_ids, token, expires_at) values ('00000000-0000-4000-8000-00000000111a', 'new@acme-agency.example', 'editor', array['00000000-0000-4000-8000-0000000111c1']::uuid[], 'rls-111-t3', now() + interval '7 days')$q$, 1);
select pg_temp.expect_rows('see that a Google connection exists',
  $q$select id, provider, connected_at from account_integrations where account_id = '00000000-0000-4000-8000-00000000111a'$q$, 1);
select pg_temp.expect_rows('mark the Search Console row for reconnect',
  $q$update workspace_integrations set needs_reconnect = true, last_sync_error = 'refused' where id = '00000000-0000-4000-8000-0000000111e1'$q$, 1);
select pg_temp.expect_rows('change a non-Google connection',
  $q$update workspace_integrations set config = '{"type":"bing","bingSiteUrl":"https://one.acme-agency.example/"}' where id = '00000000-0000-4000-8000-0000000111e2'$q$, 1);

select pg_temp.expect_rows('revoke an invite to the actor''s own site',
  $q$delete from invites where token = 'rls-111-t3'$q$, 1);
select pg_temp.expect_rows('send a site''s domain back unchanged but for case',
  $q$update workspaces set domain = 'ONE.acme-agency.example' where id = '00000000-0000-4000-8000-0000000111c1'$q$, 1);
select pg_temp.expect_rows('remove a member inside the actor''s sites',
  $q$delete from account_members where user_id = '00000000-0000-4000-8000-0000000111a3'$q$, 1);

-- --- An owner limited to client one ------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000111a6","role":"authenticated"}', true);
select pg_temp.expect_refused('a limited owner invites to every site',
  $q$insert into invites (account_id, email, role, workspace_ids, token, expires_at) values ('00000000-0000-4000-8000-00000000111a', 'other@acme-agency.example', 'admin', null, 'rls-111-t4', now() + interval '7 days')$q$);

-- --- The owner with every site -----------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000111a1","role":"authenticated"}', true);
select pg_temp.expect_rows('the owner gives a member every site',
  $q$update account_members set workspace_ids = null where user_id = '00000000-0000-4000-8000-0000000111a4'$q$, 1);
select pg_temp.expect_rows('the owner invites to every site',
  $q$insert into invites (account_id, email, role, workspace_ids, token, expires_at) values ('00000000-0000-4000-8000-00000000111a', 'wide@acme-agency.example', 'editor', null, 'rls-111-t5', now() + interval '7 days')$q$, 1);
select pg_temp.expect_rows('the owner changes a site''s domain',
  $q$update workspaces set domain = 'one-new.acme-agency.example' where id = '00000000-0000-4000-8000-0000000111c1'$q$, 1);
select pg_temp.expect_rows('the owner revokes an invite to every site',
  $q$delete from invites where id = '00000000-0000-4000-8000-0000000111f1'$q$, 1);
select pg_temp.expect_refused('the owner still cannot write a Google row from a client',
  $q$update workspace_integrations set tokens = '{"encrypted":"other"}' where id = '00000000-0000-4000-8000-0000000111e1'$q$);

-- --- The server --------------------------------------------------------------
reset role;
select set_config('request.jwt.claims', '', true);

select pg_temp.expect_refused('a key created by a member limited to some sites',
  $q$insert into api_keys (account_id, name, key_hash, prefix, scopes, created_by) values ('00000000-0000-4000-8000-00000000111a', 'k', 'h1', 'p1', array['read'], '00000000-0000-4000-8000-0000000111a2')$q$);
select pg_temp.expect_rows('a key created by a member with every site',
  $q$insert into api_keys (account_id, name, key_hash, prefix, scopes, created_by) values ('00000000-0000-4000-8000-00000000111a', 'k', 'h2', 'p2', array['read'], '00000000-0000-4000-8000-0000000111a1')$q$, 1);
select pg_temp.expect_rows('the server connects a site to Search Console',
  $q$insert into workspace_integrations (workspace_id, integration_id, config, tokens) values ('00000000-0000-4000-8000-0000000111c2', 'gsc', '{"type":"gsc","gscSiteUrl":"sc-domain:two.acme-agency.example"}', '{"encrypted":"account-consent"}')$q$, 1);
select pg_temp.expect_rows('the server refreshes a Search Console token',
  $q$update workspace_integrations set tokens = '{"encrypted":"fresh"}' where id = '00000000-0000-4000-8000-0000000111e1'$q$, 1);

do $$ begin raise notice '111: all cases passed'; end $$;

rollback;
