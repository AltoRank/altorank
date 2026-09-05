-- RLS check for migration 053, run by hand against a local Supabase.
--
--   1. Create two users through the GoTrue admin API (no passwords):
--        curl -X POST $URL/auth/v1/admin/users -H "apikey: $SERVICE" \
--          -H "Authorization: Bearer $SERVICE" -H "Content-Type: application/json" \
--          -d '{"email":"rls-full@example.test","email_confirm":true}'
--   2. Fill in the \set lines below with their ids, an agency and two of its
--      workspaces.
--   3. docker exec -i supabase_db_altorank psql -U postgres -d postgres < this file
--
-- auth.uid() is simulated with request.jwt.claims, so no sign-in is needed.
-- Expected: the FULL member counts every workspace and can add one (RETURNING
-- works); the RESTRICTED member counts exactly one everywhere, every write to
-- the hidden workspace is refused, adding a workspace and an invite are
-- refused; anon sees nothing. Ran green 2026-09-04 on PG 17.6.

-- Seed: both users join one agency. FULL sees all of its workspaces,
-- RESTRICTED sees only ws_allowed.
\set agency '<agency uuid>'
\set ws_allowed '<workspace the restricted member may see>'
\set ws_other '<another workspace of the same agency>'
\set full_uid '<auth.users.id created via the GoTrue admin API>'
\set restricted_uid '<auth.users.id created via the GoTrue admin API>'

insert into agency_members (agency_id, user_id, role, workspace_ids)
values (:'agency', :'full_uid', 'editor', null)
on conflict (agency_id, user_id) do update set workspace_ids = null;
insert into agency_members (agency_id, user_id, role, workspace_ids)
values (:'agency', :'restricted_uid', 'editor', array[:'ws_allowed']::uuid[])
on conflict (agency_id, user_id) do update set workspace_ids = array[:'ws_allowed']::uuid[];

-- One article and one keyword in each of two workspaces, so the child tables
-- have something to hide.
insert into articles (workspace_id, title, slug, keyword, status) values
  (:'ws_allowed', 'RLS allowed article', 'rls-allowed', 'rls', 'draft'),
  (:'ws_other',   'RLS hidden article',  'rls-hidden',  'rls', 'draft');
insert into keywords (workspace_id, term) values (:'ws_allowed', 'rls allowed kw'), (:'ws_other', 'rls hidden kw');

\echo '=== FULL access member (workspace_ids null)'
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'full_uid', 'role', 'authenticated')::text, true);
select 'workspaces' t, count(*) from workspaces
union all select 'user_workspace_ids()', count(*) from user_workspace_ids()
union all select 'articles', count(*) from articles where title like 'RLS %'
union all select 'keywords', count(*) from keywords where term like 'rls %';
-- Can add a site, and RETURNING works.
insert into workspaces (agency_id, name, domain) values (:'agency', 'RLS new site', 'rls-new.test') returning id, name;
rollback;

\echo '=== RESTRICTED member (one workspace)'
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'restricted_uid', 'role', 'authenticated')::text, true);
select 'workspaces' t, count(*) from workspaces
union all select 'user_workspace_ids()', count(*) from user_workspace_ids()
union all select 'articles', count(*) from articles where title like 'RLS %'
union all select 'keywords', count(*) from keywords where term like 'rls %'
union all select 'output_settings', count(*) from workspace_output_settings
union all select 'analytics_metrics', count(*) from analytics_metrics
union all select 'calendar_entries', count(*) from calendar_entries;
select title from articles where title like 'RLS %';
-- Cannot write into the hidden workspace: 0 rows updated, and the insert is refused.
update articles set title = 'pwned' where slug = 'rls-hidden';
\echo 'insert into hidden workspace (expect RLS error):'
savepoint s1;
insert into articles (workspace_id, title, slug, status) values (:'ws_other', 'x', 'x', 'draft');
rollback to savepoint s1;
\echo 'insert into allowed workspace (expect 1 row):'
insert into articles (workspace_id, title, slug, status) values (:'ws_allowed', 'RLS ok', 'rls-ok', 'draft') returning title;
\echo 'add a workspace (expect RLS error):'
savepoint s2;
insert into workspaces (agency_id, name, domain) values (:'agency', 'RLS new site', 'rls-new.test');
rollback to savepoint s2;
\echo 'invite as editor (expect RLS error):'
savepoint s3;
insert into invites (agency_id, email, role, token, invited_by, expires_at) values (:'agency', 'x@y.z', 'editor', 'tok', :'restricted_uid', now());
rollback to savepoint s3;
rollback;

\echo '=== anon'
begin;
set local role anon;
select count(*) from workspaces;
savepoint s4;
select count(*) from user_workspace_ids();
rollback to savepoint s4;
rollback;

-- Clean up the seed rows.
delete from articles where slug in ('rls-allowed', 'rls-hidden');
delete from keywords where term like 'rls %';
