-- Check for migration 109, run by hand against a database that has
-- migrations up to 109 applied (an isolated copy is best: this file writes
-- nothing that survives it, but it does write inside its transaction).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/109_approval_written_by_server.rls.sql
--
-- Self-contained: it seeds two invented users, one account, one site and
-- three articles inside one transaction, checks every case, and rolls back. A
-- case that does not behave raises, so ON_ERROR_STOP turns it into a non-zero
-- exit; a green run ends with "109: all cases passed". auth.uid() is
-- simulated with request.jwt.claims, as PostgREST sets it.

begin;

insert into auth.users (id, email, instance_id, aud, role) values
  ('00000000-0000-4000-8000-0000000109a1', 'owner@acme-agency.example', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000109a2', 'editor@acme-agency.example', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');

insert into accounts (id, name, slug, plan, plan_status) values
  ('00000000-0000-4000-8000-00000000109a', 'Acme', 'rls-109-acme', 'starter', 'active');
insert into workspaces (id, account_id, name, domain) values
  ('00000000-0000-4000-8000-0000000109c1', '00000000-0000-4000-8000-00000000109a', 'acme site', 'acme.acme-agency.example');
insert into account_members (account_id, user_id, role, workspace_ids) values
  ('00000000-0000-4000-8000-00000000109a', '00000000-0000-4000-8000-0000000109a1', 'owner', null),
  ('00000000-0000-4000-8000-00000000109a', '00000000-0000-4000-8000-0000000109a2', 'editor', null);
-- d1: a draft in review. d2: approved by the owner. d3: scheduled by the owner.
insert into articles (id, workspace_id, title, slug, content, status, approved_by, approved_at, approval_kind, scheduled_at) values
  ('00000000-0000-4000-8000-0000000109d1', '00000000-0000-4000-8000-0000000109c1', 'Draft', 'draft', '{"type":"doc"}', 'review', null, null, null, null),
  ('00000000-0000-4000-8000-0000000109d2', '00000000-0000-4000-8000-0000000109c1', 'Approved', 'approved', '{"type":"doc"}', 'approved', '00000000-0000-4000-8000-0000000109a1', now(), 'human', null),
  ('00000000-0000-4000-8000-0000000109d3', '00000000-0000-4000-8000-0000000109c1', 'Scheduled', 'scheduled', '{"type":"doc"}', 'scheduled', '00000000-0000-4000-8000-0000000109a1', now(), 'human', now() + interval '1 day');

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
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000109a2","role":"authenticated"}', true);

select pg_temp.expect_refused('approve a draft by status alone',
  $q$update articles set status = 'approved' where id = '00000000-0000-4000-8000-0000000109d1'$q$);
select pg_temp.expect_refused('schedule a draft under a colleague''s name',
  $q$update articles set status = 'scheduled', approved_by = '00000000-0000-4000-8000-0000000109a1' where id = '00000000-0000-4000-8000-0000000109d1'$q$);
select pg_temp.expect_refused('mark a draft live',
  $q$update articles set status = 'live' where id = '00000000-0000-4000-8000-0000000109d1'$q$);
select pg_temp.expect_refused('re-sign an approval as someone else',
  $q$update articles set approved_by = '00000000-0000-4000-8000-0000000109a2' where id = '00000000-0000-4000-8000-0000000109d2'$q$);
select pg_temp.expect_refused('approved to scheduled without the action',
  $q$update articles set status = 'scheduled' where id = '00000000-0000-4000-8000-0000000109d2'$q$);
select pg_temp.expect_refused('move a schedule',
  $q$update articles set scheduled_at = now() where id = '00000000-0000-4000-8000-0000000109d3'$q$);
select pg_temp.expect_refused('insert an article already approved',
  $q$insert into articles (workspace_id, title, slug, status, approved_by) values ('00000000-0000-4000-8000-0000000109c1', 'Forged', 'forged', 'approved', '00000000-0000-4000-8000-0000000109a1')$q$);

select pg_temp.expect_rows('edit a draft''s title',
  $q$update articles set title = 'Draft, renamed' where id = '00000000-0000-4000-8000-0000000109d1'$q$, 1);
select pg_temp.expect_rows('insert a new draft',
  $q$insert into articles (workspace_id, title, slug, status) values ('00000000-0000-4000-8000-0000000109c1', 'New', 'new', 'draft')$q$, 1);
select pg_temp.expect_rows('cancel a schedule (back to review, held)',
  $q$update articles set status = 'review', held_by = auth.uid(), held_at = now() where id = '00000000-0000-4000-8000-0000000109d3'$q$, 1);
select pg_temp.expect_rows('request changes, clearing the approval by hand',
  $q$update articles set status = 'review', approved_by = null, approved_at = null, approval_kind = null where id = '00000000-0000-4000-8000-0000000109d2'$q$, 1);

reset role;

do $$
begin
  if exists (select 1 from articles
              where id = '00000000-0000-4000-8000-0000000109d3'
                and (approved_by is not null or approved_at is not null or approval_kind is not null or scheduled_at is not null)) then
    raise exception 'FAIL leaving scheduled kept the approval';
  end if;
  if (select status from articles where id = '00000000-0000-4000-8000-0000000109d1') <> 'review' then
    raise exception 'FAIL the draft moved';
  end if;
end $$;

-- The server (service role, no auth.uid()) still approves and schedules.
set local role service_role;
select set_config('request.jwt.claims', '', true);
update articles set status = 'approved', approved_by = '00000000-0000-4000-8000-0000000109a1', approved_at = now(), approval_kind = 'human'
 where id = '00000000-0000-4000-8000-0000000109d1';
update articles set status = 'scheduled', scheduled_at = now() + interval '2 days'
 where id = '00000000-0000-4000-8000-0000000109d1';
reset role;

do $$
begin
  if (select approved_by from articles where id = '00000000-0000-4000-8000-0000000109d1') is distinct from '00000000-0000-4000-8000-0000000109a1' then
    raise exception 'FAIL the server could not approve';
  end if;
end $$;

\echo '109: all cases passed'
rollback;
