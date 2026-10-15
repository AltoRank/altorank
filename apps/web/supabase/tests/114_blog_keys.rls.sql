-- Check for migration 114, run by hand against a database that has
-- migrations up to 114 applied (an isolated copy is best: this file writes
-- nothing that survives it, but it does write inside its transaction).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/114_blog_keys.rls.sql
--
-- Self-contained: it seeds two invented accounts with a site each, checks
-- every case, and rolls back. A case that does not behave raises, so
-- ON_ERROR_STOP turns it into a non-zero exit; a green run ends with
-- "114: all cases passed". Writes run as the server (the service role or the
-- table owner), which is the only writer of api_keys since 099.

begin;

insert into accounts (id, name, slug, plan, plan_status) values
  ('00000000-0000-4000-8000-00000000114a', 'Acme', 'rls-114-acme', 'agency', 'active'),
  ('00000000-0000-4000-8000-00000000114b', 'Other', 'rls-114-other', 'agency', 'active');
insert into workspaces (id, account_id, name, domain) values
  ('00000000-0000-4000-8000-0000000114c1', '00000000-0000-4000-8000-00000000114a', 'client one', 'one.acme-agency.example'),
  ('00000000-0000-4000-8000-0000000114c2', '00000000-0000-4000-8000-00000000114b', 'other site', 'other.example');

create function pg_temp.expect_error(label text, stmt text, state text) returns void language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    if sqlstate = state then
      raise notice 'ok   refused (%): %', state, label;
      return;
    end if;
    raise exception 'FAIL %: % (%), expected %', label, sqlerrm, sqlstate, state;
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

-- --- Shape -------------------------------------------------------------------
select pg_temp.expect_rows('an agent key with no site, as before',
  $q$insert into api_keys (account_id, name, key_hash, prefix, scopes) values ('00000000-0000-4000-8000-00000000114a', 'agent', 'rls-114-h1', 'p', array['read','generate'])$q$, 1);
select pg_temp.expect_rows('a blog key for a site on its account',
  $q$insert into api_keys (account_id, name, key_hash, prefix, scopes, workspace_id) values ('00000000-0000-4000-8000-00000000114a', 'blog', 'rls-114-h2', 'p', array['blog'], '00000000-0000-4000-8000-0000000114c1')$q$, 1);
select pg_temp.expect_error('a blog key with no site',
  $q$insert into api_keys (account_id, name, key_hash, prefix, scopes) values ('00000000-0000-4000-8000-00000000114a', 'blog', 'rls-114-h3', 'p', array['blog'])$q$, '23514');
select pg_temp.expect_error('a key with a site and agent scopes',
  $q$insert into api_keys (account_id, name, key_hash, prefix, scopes, workspace_id) values ('00000000-0000-4000-8000-00000000114a', 'x', 'rls-114-h4', 'p', array['read'], '00000000-0000-4000-8000-0000000114c1')$q$, '23514');
select pg_temp.expect_error('a blog key that also has an agent scope',
  $q$insert into api_keys (account_id, name, key_hash, prefix, scopes, workspace_id) values ('00000000-0000-4000-8000-00000000114a', 'x', 'rls-114-h5', 'p', array['blog','read'], '00000000-0000-4000-8000-0000000114c1')$q$, '23514');
select pg_temp.expect_error('widening a blog key to agent scopes',
  $q$update api_keys set scopes = array['blog','write'] where key_hash = 'rls-114-h2'$q$, '23514');

-- --- The site is the key's own account's --------------------------------------
select pg_temp.expect_error('a blog key for another account''s site',
  $q$insert into api_keys (account_id, name, key_hash, prefix, scopes, workspace_id) values ('00000000-0000-4000-8000-00000000114a', 'x', 'rls-114-h6', 'p', array['blog'], '00000000-0000-4000-8000-0000000114c2')$q$, '42501');
select pg_temp.expect_error('moving a blog key to another account''s site',
  $q$update api_keys set workspace_id = '00000000-0000-4000-8000-0000000114c2' where key_hash = 'rls-114-h2'$q$, '42501');
select pg_temp.expect_rows('revoking a blog key',
  $q$update api_keys set revoked_at = now() where key_hash = 'rls-114-h2'$q$, 1);

-- --- A client token still writes only revoked_at ------------------------------
do $$
begin
  if has_column_privilege('authenticated', 'public.api_keys', 'workspace_id', 'UPDATE') then
    raise exception 'FAIL a client token can set a key''s site';
  end if;
  if not has_column_privilege('authenticated', 'public.api_keys', 'revoked_at', 'UPDATE') then
    raise exception 'FAIL a client token can no longer revoke a key';
  end if;
  if has_table_privilege('authenticated', 'public.api_keys', 'INSERT') then
    raise exception 'FAIL a client token can insert a key';
  end if;
  raise notice 'ok   client tokens: revoke only';
end $$;

-- --- Deleting the site deletes its blog keys ----------------------------------
select pg_temp.expect_rows('the site goes',
  $q$delete from workspaces where id = '00000000-0000-4000-8000-0000000114c1'$q$, 1);
do $$
begin
  if exists (select 1 from api_keys where key_hash = 'rls-114-h2') then
    raise exception 'FAIL the blog key outlived its site';
  end if;
  if not exists (select 1 from api_keys where key_hash = 'rls-114-h1') then
    raise exception 'FAIL the agent key went with the site';
  end if;
  raise notice 'ok   a deleted site takes its blog keys, not agent keys';
end $$;

do $$ begin raise notice '114: all cases passed'; end $$;

rollback;
