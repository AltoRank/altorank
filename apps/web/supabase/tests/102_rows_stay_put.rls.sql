-- RLS check for migration 102, run by hand against a database that has
-- migrations up to 102 applied (an isolated copy is best: this file writes
-- nothing that survives it, but it does write inside its transaction).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/102_rows_stay_put.rls.sql
--
-- Self-contained: it seeds three invented users, two accounts and their sites
-- inside one transaction, checks every case, and rolls back. A case that does
-- not behave raises, so ON_ERROR_STOP turns it into a non-zero exit; a green
-- run ends with "102: all cases passed". auth.uid() is simulated with
-- request.jwt.claims, as PostgREST sets it. Ran green 2026-09-25 on PG 17.

begin;

insert into auth.users (id, email, instance_id, aud, role) values
  ('00000000-0000-4000-8000-0000000102a1', 'gated-owner@acme-agency.example', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000102a2', 'gated-admin@acme-agency.example', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000102a3', 'paying-owner@acme-agency.example', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');

-- A: no plan, its one pre-trial article attempted. B: paying.
insert into accounts (id, name, slug, plan, plan_status, free_drafts_used) values
  ('00000000-0000-4000-8000-00000000102a', 'Gated', 'rls-102-gated', 'starter', 'canceled', 1),
  ('00000000-0000-4000-8000-00000000102b', 'Paying', 'rls-102-paying', 'starter', 'active', 0);
insert into workspaces (id, account_id, name, domain) values
  ('00000000-0000-4000-8000-0000000102c1', '00000000-0000-4000-8000-00000000102a', 'gated site', 'gated.acme-agency.example'),
  ('00000000-0000-4000-8000-0000000102c2', '00000000-0000-4000-8000-00000000102b', 'paying site', 'paying.acme-agency.example'),
  ('00000000-0000-4000-8000-0000000102c3', '00000000-0000-4000-8000-00000000102a', 'gated second site', 'second.acme-agency.example');
-- The gated owner is also an editor of ONE site of the paying account; the
-- gated admin sees one site of the gated account.
insert into account_members (account_id, user_id, role, workspace_ids) values
  ('00000000-0000-4000-8000-00000000102a', '00000000-0000-4000-8000-0000000102a1', 'owner', null),
  ('00000000-0000-4000-8000-00000000102a', '00000000-0000-4000-8000-0000000102a2', 'admin', array['00000000-0000-4000-8000-0000000102c1']::uuid[]),
  ('00000000-0000-4000-8000-00000000102b', '00000000-0000-4000-8000-0000000102a3', 'owner', null),
  ('00000000-0000-4000-8000-00000000102b', '00000000-0000-4000-8000-0000000102a1', 'editor', array['00000000-0000-4000-8000-0000000102c2']::uuid[]);
insert into articles (id, workspace_id, title, slug, content, status) values
  ('00000000-0000-4000-8000-0000000102d1', '00000000-0000-4000-8000-0000000102c1', 'Pre-trial article', 'pre-trial', '{"type":"doc"}', 'review');
insert into calendar_entries (workspace_id, keyword, scheduled_date) values
  ('00000000-0000-4000-8000-0000000102c1', 'rls 102 keyword', current_date);
insert into onboarding_runs (workspace_id, account_id) values
  ('00000000-0000-4000-8000-0000000102c3', '00000000-0000-4000-8000-00000000102a');

-- expect_refused(sql): the statement must fail with 42501.
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

-- expect_rows(sql, n): the statement must succeed and touch n rows.
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

-- --- The gated owner, who is also an editor of the paying account ----------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000102a1","role":"authenticated"}', true);

select pg_temp.expect_refused('move the pre-trial article into the paying site',
  $q$update articles set workspace_id = '00000000-0000-4000-8000-0000000102c2' where id = '00000000-0000-4000-8000-0000000102d1'$q$);
select pg_temp.expect_refused('move a calendar entry into the paying site',
  $q$update calendar_entries set workspace_id = '00000000-0000-4000-8000-0000000102c2' where keyword = 'rls 102 keyword'$q$);
select pg_temp.expect_rows('rename the article in place',
  $q$update articles set title = 'Renamed' where id = '00000000-0000-4000-8000-0000000102d1'$q$, 1);
select pg_temp.expect_refused('owner demotes themselves',
  $q$update account_members set role = 'admin' where user_id = auth.uid() and account_id = '00000000-0000-4000-8000-00000000102a'$q$);
-- Deleting a site: its onboarding run is kept with workspace_id null (100),
-- a change the foreign key makes, which the trigger lets through.
select pg_temp.expect_rows('delete a site (runs set null by the foreign key)',
  $q$delete from workspaces where id = '00000000-0000-4000-8000-0000000102c3'$q$, 1);

-- --- The gated account's admin ---------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000102a2","role":"authenticated"}', true);

select pg_temp.expect_refused('admin deletes the owner',
  $q$delete from account_members where account_id = '00000000-0000-4000-8000-00000000102a' and user_id = '00000000-0000-4000-8000-0000000102a1'$q$);
select pg_temp.expect_refused('admin demotes the owner',
  $q$update account_members set role = 'editor' where account_id = '00000000-0000-4000-8000-00000000102a' and user_id = '00000000-0000-4000-8000-0000000102a1'$q$);
select pg_temp.expect_refused('admin makes themselves owner',
  $q$update account_members set role = 'owner' where user_id = auth.uid()$q$);
select pg_temp.expect_refused('admin widens their own sites to all',
  $q$update account_members set workspace_ids = null where user_id = auth.uid()$q$);

-- --- The gated owner manages the admin, as the Team page does ---------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000102a1","role":"authenticated"}', true);

select pg_temp.expect_rows('owner changes the admin''s sites',
  $q$update account_members set workspace_ids = null where user_id = '00000000-0000-4000-8000-0000000102a2'$q$, 1);
select pg_temp.expect_rows('owner makes the admin an owner',
  $q$update account_members set role = 'owner' where user_id = '00000000-0000-4000-8000-0000000102a2'$q$, 1);
select pg_temp.expect_rows('owner removes a member',
  $q$delete from account_members where user_id = '00000000-0000-4000-8000-0000000102a2'$q$, 1);

reset role;

do $$
begin
  if (select workspace_id from articles where id = '00000000-0000-4000-8000-0000000102d1') <> '00000000-0000-4000-8000-0000000102c1' then
    raise exception 'FAIL the article moved';
  end if;
  if (select count(*) from onboarding_runs where account_id = '00000000-0000-4000-8000-00000000102a' and workspace_id is null) <> 1 then
    raise exception 'FAIL the deleted site''s run was not kept';
  end if;
end $$;

-- The server (service role, no auth.uid()) still may.
set local role service_role;
select set_config('request.jwt.claims', '', true);
update articles set workspace_id = '00000000-0000-4000-8000-0000000102c2' where id = '00000000-0000-4000-8000-0000000102d1';
reset role;

\echo '102: all cases passed'
rollback;
