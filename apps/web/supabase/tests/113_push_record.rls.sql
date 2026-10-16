-- Check for migration 113, run by hand against a database that has
-- migrations up to 113 applied (an isolated copy is best: this file writes
-- nothing that survives it, but it does write inside its transaction).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/113_push_record.rls.sql
--
-- Self-contained: it seeds two invented users, one account, one site, a
-- candidate, a task and three executions inside one transaction, checks every
-- case, and rolls back. A case that does not behave raises, so ON_ERROR_STOP
-- turns it into a non-zero exit; a green run ends with "113: all cases
-- passed". auth.uid() is simulated with request.jwt.claims, as PostgREST sets it.

begin;

insert into auth.users (id, email, instance_id, aud, role) values
  ('00000000-0000-4000-8000-0000000113a1', 'owner@acme-agency.example', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000113a2', 'editor@acme-agency.example', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');

insert into accounts (id, name, slug, plan, plan_status) values
  ('00000000-0000-4000-8000-00000000113a', 'Acme', 'rls-113-acme', 'starter', 'active');
insert into workspaces (id, account_id, name, domain) values
  ('00000000-0000-4000-8000-0000000113c1', '00000000-0000-4000-8000-00000000113a', 'acme site', 'acme.acme-agency.example');
insert into account_members (account_id, user_id, role, workspace_ids) values
  ('00000000-0000-4000-8000-00000000113a', '00000000-0000-4000-8000-0000000113a1', 'owner', null),
  ('00000000-0000-4000-8000-00000000113a', '00000000-0000-4000-8000-0000000113a2', 'editor', null);
insert into refresh_candidates (id, workspace_id, url, opportunity, evidence) values
  ('00000000-0000-4000-8000-0000000113b1', '00000000-0000-4000-8000-0000000113c1', 'https://acme.acme-agency.example/blog/a', 'thin', '{}');
insert into refresh_tasks (id, candidate_id, workspace_id, scheduled_for, status) values
  ('00000000-0000-4000-8000-0000000113d1', '00000000-0000-4000-8000-0000000113b1', '00000000-0000-4000-8000-0000000113c1', current_date, 'done');
-- e1, e2: awaiting review. e3: pushed by the owner.
insert into refresh_executions (id, task_id, workspace_id, review_status, pushed_at, pushed_by, published_url) values
  ('00000000-0000-4000-8000-0000000113e1', '00000000-0000-4000-8000-0000000113d1', '00000000-0000-4000-8000-0000000113c1', 'awaiting_review', null, null, null),
  ('00000000-0000-4000-8000-0000000113e2', '00000000-0000-4000-8000-0000000113d1', '00000000-0000-4000-8000-0000000113c1', 'awaiting_review', null, null, null),
  ('00000000-0000-4000-8000-0000000113e3', '00000000-0000-4000-8000-0000000113d1', '00000000-0000-4000-8000-0000000113c1', 'pushed', now(), '00000000-0000-4000-8000-0000000113a1', 'https://acme.acme-agency.example/blog/a');

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

-- --- The editor, over PostgREST --------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000113a2","role":"authenticated"}', true);

select pg_temp.expect_refused('mark an execution pushed',
  $q$update refresh_executions set review_status = 'pushed' where id = '00000000-0000-4000-8000-0000000113e1'$q$);
select pg_temp.expect_refused('record a push under a colleague''s name',
  $q$update refresh_executions set pushed_by = '00000000-0000-4000-8000-0000000113a1' where id = '00000000-0000-4000-8000-0000000113e1'$q$);
select pg_temp.expect_refused('rewrite who pushed',
  $q$update refresh_executions set pushed_by = '00000000-0000-4000-8000-0000000113a2' where id = '00000000-0000-4000-8000-0000000113e3'$q$);
select pg_temp.expect_refused('clear who pushed',
  $q$update refresh_executions set pushed_by = null where id = '00000000-0000-4000-8000-0000000113e3'$q$);
select pg_temp.expect_refused('move a push''s date',
  $q$update refresh_executions set pushed_at = now() - interval '1 day' where id = '00000000-0000-4000-8000-0000000113e3'$q$);
select pg_temp.expect_refused('put a pushed execution back to review',
  $q$update refresh_executions set review_status = 'awaiting_review' where id = '00000000-0000-4000-8000-0000000113e3'$q$);
select pg_temp.expect_refused('change where a push went',
  $q$update refresh_executions set published_url = 'https://elsewhere.example/' where id = '00000000-0000-4000-8000-0000000113e3'$q$);
select pg_temp.expect_refused('insert an execution already pushed',
  $q$insert into refresh_executions (task_id, workspace_id, review_status, pushed_by) values ('00000000-0000-4000-8000-0000000113d1', '00000000-0000-4000-8000-0000000113c1', 'pushed', '00000000-0000-4000-8000-0000000113a1')$q$);

select pg_temp.expect_rows('save decisions',
  $q$update refresh_executions set decisions = '{"decisions":{"h1":"accepted"},"edited":{},"fields":{}}' where id = '00000000-0000-4000-8000-0000000113e1' and review_status = 'awaiting_review'$q$, 1);
select pg_temp.expect_rows('reject a rewrite',
  $q$update refresh_executions set review_status = 'rejected' where id = '00000000-0000-4000-8000-0000000113e2' and review_status = 'awaiting_review'$q$, 1);

reset role;

-- The server (service role, no auth.uid()) still records a push.
set local role service_role;
select set_config('request.jwt.claims', '', true);
update refresh_executions
   set review_status = 'pushed', pushed_at = now(), published_url = 'https://acme.acme-agency.example/blog/a',
       pushed_by = '00000000-0000-4000-8000-0000000113a2'
 where id = '00000000-0000-4000-8000-0000000113e1';
reset role;

do $$
begin
  if (select pushed_by from refresh_executions where id = '00000000-0000-4000-8000-0000000113e1') is distinct from '00000000-0000-4000-8000-0000000113a2' then
    raise exception 'FAIL the server could not record a push';
  end if;
  if (select pushed_by from refresh_executions where id = '00000000-0000-4000-8000-0000000113e3') is distinct from '00000000-0000-4000-8000-0000000113a1' then
    raise exception 'FAIL the owner''s push record changed';
  end if;
  if (select review_status from refresh_executions where id = '00000000-0000-4000-8000-0000000113e2') <> 'rejected' then
    raise exception 'FAIL reject did not stick';
  end if;
end $$;

\echo '113: all cases passed'
rollback;
