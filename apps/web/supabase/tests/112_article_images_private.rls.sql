-- Check for migration 112, run by hand against a database that has
-- migrations up to 112 applied (an isolated copy is best: this file writes
-- nothing that survives it, but it does write inside its transaction).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/112_article_images_private.rls.sql
--
-- Self-contained: it seeds two objects in `article-images` inside one
-- transaction, checks that neither anon nor a signed-in user can select (so
-- list) them through the API roles, that the service role still can, and
-- rolls back. A green run ends with "112: all cases passed".

begin;

insert into storage.objects (bucket_id, name) values
  ('article-images', '00000000-0000-4000-8000-0000000112c1/00000000-0000-4000-8000-0000000112d1.webp'),
  ('article-images', '00000000-0000-4000-8000-0000000112c1/00000000-0000-4000-8000-0000000112d1/proposals/1.png');

create function pg_temp.visible(r text) returns int language plpgsql as $$
declare
  n int;
begin
  execute format('set local role %I', r);
  select count(*) into n from storage.objects
   where bucket_id = 'article-images' and name like '00000000-0000-4000-8000-0000000112c1/%';
  reset role;
  return n;
end $$;

do $$
begin
  if pg_temp.visible('anon') <> 0 then raise exception 'FAIL anon can list article images'; end if;
  raise notice 'ok   refused: anon lists article images';
  if pg_temp.visible('authenticated') <> 0 then raise exception 'FAIL a signed-in user can list article images'; end if;
  raise notice 'ok   refused: a signed-in user lists article images';
  if pg_temp.visible('service_role') <> 2 then raise exception 'FAIL the service role cannot list article images'; end if;
  raise notice 'ok   allowed: the service role lists article images';
  if not exists (select 1 from storage.buckets where id = 'article-images' and public) then
    raise exception 'FAIL the bucket is no longer public by path';
  end if;
  raise notice 'ok   allowed: the bucket stays public by path';
  raise notice '112: all cases passed';
end $$;

rollback;
