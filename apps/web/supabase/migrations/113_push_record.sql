-- 113: who pushed a reviewed rewrite, and a push recorded only by the server
-- Depends on: 052_refresh_engine (refresh_executions), auth.users.
-- Apply AFTER its code is live, like 109: see RUNBOOK.md.
--
-- "Push to site" on Improvements writes a reviewed rewrite onto a live post.
-- It now runs the gates of a publish and records the person who pressed it
-- as the approval of the new text on the article (approved_by, approved_at,
-- written by the server; 109 holds clients off those columns). This adds the
-- same record to the execution itself, `pushed_by`, so each push says who
-- made it after the article's approval has moved on to a later one.
--
-- The push's record on an execution is written by the server
-- (lib/refresh/push.ts). "Refresh executions by access" (062) is FOR ALL on
-- site membership, so without a guard any member could PATCH
-- `{review_status: 'pushed', pushed_by: <a colleague>}` over PostgREST. For a
-- signed-in user (`auth.uid()` set) the trigger below refuses:
--
-- 1. an INSERT that starts pushed or carries pushed_at, pushed_by or
--    published_url (executions are written by the refresh cron);
-- 2. moving an execution to `pushed`, or out of `pushed`;
-- 3. any change to pushed_at, pushed_by or published_url.
--
-- Saving decisions and Reject still work: they write `decisions` and
-- `review_status = 'rejected'` on an execution awaiting review. Like 109 it
-- passes the service role (no `auth.uid()`: the server, the crons, psql) and
-- a change the database makes itself (`pg_trigger_depth() > 1`, such as the
-- foreign key's `on delete set null` below).
--
-- Idempotent: `add column if not exists`, create or replace, drop-then-create
-- the trigger. Rollback in RUNBOOK.md.

alter table public.refresh_executions
  add column if not exists pushed_by uuid references auth.users(id) on delete set null;

comment on column public.refresh_executions.pushed_by is
  'The person who pushed this reviewed rewrite to the site. Written by the server with pushed_at; a signed-in client cannot set it (refresh_executions_guard_push).';

-- caller: internal (trigger only - see the REVOKE below)
create or replace function public.refresh_executions_guard_push()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if pg_trigger_depth() = 0 then
    raise exception 'refresh_executions_guard_push is a trigger function'
      using errcode = '42501';
  end if;

  -- The server, psql, and the database's own cascades.
  if auth.uid() is null or pg_trigger_depth() > 1 then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.review_status = 'pushed'
       or new.pushed_at is not null
       or new.pushed_by is not null
       or new.published_url is not null
    then
      raise exception 'A rewrite is pushed by AltoRank, not by a signed-in user'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if (new.review_status is distinct from old.review_status
        and (new.review_status = 'pushed' or old.review_status = 'pushed'))
     or new.pushed_at is distinct from old.pushed_at
     or new.pushed_by is distinct from old.pushed_by
     or new.published_url is distinct from old.published_url
  then
    raise exception 'A rewrite is pushed by AltoRank, not by a signed-in user'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke execute on function public.refresh_executions_guard_push() from public, anon, authenticated;

drop trigger if exists refresh_executions_guard_push on public.refresh_executions;
create trigger refresh_executions_guard_push
  before insert or update on public.refresh_executions
  for each row execute function public.refresh_executions_guard_push();
