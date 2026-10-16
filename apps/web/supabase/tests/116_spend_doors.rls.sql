-- Check for migration 116, run by hand against a database that has
-- migrations up to 116 applied (an isolated copy is best: this file writes
-- nothing that survives it, but it does write inside its transaction).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/116_spend_doors.rls.sql
--
-- Self-contained: it seeds one account with two sites and a few spend rows
-- inside one transaction, checks every case, and rolls back. A case that does
-- not behave raises, so ON_ERROR_STOP turns it into a non-zero exit; a green
-- run ends with "116: all cases passed". The request's role is simulated with
-- request.jwt.claims, as PostgREST sets it.

begin;

insert into accounts (id, name, slug) values
  ('00000000-0000-4000-8000-00000000116a', 'Acme', 'rls-116-acme');
insert into workspaces (id, account_id, name, domain) values
  ('00000000-0000-4000-8000-0000000116c1', '00000000-0000-4000-8000-00000000116a', 'one', 'one.acme-agency.example'),
  ('00000000-0000-4000-8000-0000000116c2', '00000000-0000-4000-8000-00000000116a', 'two', 'two.acme-agency.example');

create function pg_temp.take(ws uuid, door text, limits jsonb) returns uuid language sql as $$
  select use_id from public.take_spend_door('00000000-0000-4000-8000-00000000116a', ws, door, limits)
$$;

do $$
declare
  ws1 uuid := '00000000-0000-4000-8000-0000000116c1';
  ws2 uuid := '00000000-0000-4000-8000-0000000116c2';
  site_and_account jsonb := '[{"scope":"workspace","limit":2,"seconds":86400},{"scope":"account","limit":3,"seconds":86400}]';
  r record;
begin
  -- Two per site, three per account.
  if pg_temp.take(ws1, 'wizard-site-read', site_and_account) is null then raise exception 'FAIL first press refused'; end if;
  if pg_temp.take(ws1, 'wizard-site-read', site_and_account) is null then raise exception 'FAIL second press refused'; end if;
  select * into r from public.take_spend_door('00000000-0000-4000-8000-00000000116a', ws1, 'wizard-site-read', site_and_account);
  if r.use_id is not null or r.refused_index <> 0 then raise exception 'FAIL third press on one site: %', r; end if;
  if pg_temp.take(ws2, 'wizard-site-read', site_and_account) is null then raise exception 'FAIL other site refused'; end if;
  select * into r from public.take_spend_door('00000000-0000-4000-8000-00000000116a', ws2, 'wizard-site-read', site_and_account);
  if r.use_id is not null or r.refused_index <> 1 then raise exception 'FAIL account limit: %', r; end if;
  raise notice 'ok   site and account limits';

  -- A refused press writes nothing.
  if (select count(*) from public.spend_door_uses where door = 'wizard-site-read') <> 3 then
    raise exception 'FAIL a refused press was counted';
  end if;
  raise notice 'ok   refusals are not counted';

  -- Doors are counted apart.
  if pg_temp.take(ws1, 'wizard-rivals', site_and_account) is null then raise exception 'FAIL another door shared the count'; end if;
  raise notice 'ok   doors counted apart';

  -- Outside the window it is free again; a null window counts everything.
  update public.spend_door_uses set used_at = now() - interval '2 days' where door = 'wizard-site-read';
  if pg_temp.take(ws1, 'wizard-site-read', site_and_account) is null then raise exception 'FAIL window did not move'; end if;
  if pg_temp.take(ws1, 'wizard-site-read', '[{"scope":"account","limit":4,"seconds":null}]') is not null then
    raise exception 'FAIL lifetime limit let a fifth press through';
  end if;
  raise notice 'ok   windows, and the lifetime count';

  -- Deleting the site keeps its count on the account.
  delete from workspaces where id = ws2;
  if (select count(*) from public.spend_door_uses where door = 'wizard-site-read' and workspace_id is null) <> 1 then
    raise exception 'FAIL the site''s uses went with it';
  end if;
  raise notice 'ok   a use outlives its site';
end $$;

-- provider_spend_summary sums every row, not the newest thousand.
insert into provider_spend (workspace_id, provider, operation, cost_usd, created_at, job)
select '00000000-0000-4000-8000-0000000116c1', 'dataforseo', '/serp/google/organic/task_get/regular', 0.001, now() - (g || ' minutes')::interval, 'cron.serp'
from generate_series(1, 1500) g;
do $$
declare
  s jsonb := public.provider_spend_summary(now() - interval '30 days');
  ours numeric;
begin
  select sum((g->>'usd')::numeric) into ours
    from jsonb_array_elements(s->'groups') g
   where g->>'workspace_id' = '00000000-0000-4000-8000-0000000116c1';
  if ours <> 1.5 then raise exception 'FAIL summary summed % for 1,500 rows of $0.001', ours; end if;
  raise notice 'ok   the summary sums every row';
  if not exists (select 1 from jsonb_array_elements(s->'groups') g where g->>'job' = 'cron.serp') then
    raise exception 'FAIL the summary does not group by job';
  end if;
  raise notice 'ok   the summary groups by job';
end $$;

-- model_articles counts the articles a model call wrote, not ones the editor
-- or the scheduled refresh alone paid for.
create temp table before_116 as
  select (public.provider_spend_summary(now())->>'model_articles')::integer as n;
insert into articles (id, workspace_id, title, slug) values
  ('00000000-0000-4000-8000-0000000116e1', '00000000-0000-4000-8000-0000000116c1', 'written', 'rls-116-written'),
  ('00000000-0000-4000-8000-0000000116e2', '00000000-0000-4000-8000-0000000116c1', 'edited', 'rls-116-edited'),
  ('00000000-0000-4000-8000-0000000116e3', '00000000-0000-4000-8000-0000000116c1', 'refreshed', 'rls-116-refreshed');
insert into provider_spend (workspace_id, article_id, provider, operation, cost_usd, job) values
  ('00000000-0000-4000-8000-0000000116c1', '00000000-0000-4000-8000-0000000116e1', 'anthropic', 'claude-sonnet-5', 0.3, 'cron.generate'),
  ('00000000-0000-4000-8000-0000000116c1', '00000000-0000-4000-8000-0000000116e2', 'anthropic', 'editor/rewrite', 0.6, 'editor'),
  ('00000000-0000-4000-8000-0000000116c1', '00000000-0000-4000-8000-0000000116e2', 'anthropic', 'editor/micro', 0.01, null),
  ('00000000-0000-4000-8000-0000000116c1', '00000000-0000-4000-8000-0000000116e3', 'anthropic', 'claude-sonnet-5', 0.4, 'cron.refresh');
do $$
declare
  added integer := (public.provider_spend_summary(now())->>'model_articles')::integer - (select n from before_116);
begin
  if added <> 1 then raise exception 'FAIL model_articles grew by % for one written article', added; end if;
  raise notice 'ok   model_articles leaves out the editor and the refresh';
end $$;

-- --- A client token -----------------------------------------------------------

set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-0000000116a1"}';
set local role authenticated;
do $$
begin
  begin
    perform public.take_spend_door('00000000-0000-4000-8000-00000000116a', null, 'editor-rewrite', '[]');
    raise exception 'FAIL a client token called take_spend_door';
  exception when insufficient_privilege then raise notice 'ok   refused: take_spend_door';
  end;
  begin
    perform public.provider_spend_summary(now());
    raise exception 'FAIL a client token called provider_spend_summary';
  exception when insufficient_privilege then raise notice 'ok   refused: provider_spend_summary';
  end;
  begin
    perform 1 from public.spend_door_uses;
    raise exception 'FAIL a client token read spend_door_uses';
  exception when insufficient_privilege then raise notice 'ok   refused: read spend_door_uses';
  end;
  begin
    insert into public.spend_door_uses (account_id, door) values ('00000000-0000-4000-8000-00000000116a', 'editor-rewrite');
    raise exception 'FAIL a client token wrote spend_door_uses';
  exception when insufficient_privilege then raise notice 'ok   refused: write spend_door_uses';
  end;
end $$;
reset role;

select '116: all cases passed' as result;
rollback;
