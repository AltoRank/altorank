-- 119: the exception rules a site turned off, and when a person last edited a draft
-- Depends on: 079_auto_approve (workspaces.auto_approve_*), 013_approval_workflow
-- (articles.approved_at), 109_approval_written_by_server (approval_kind is
-- server-written). Nothing in 110-118.
-- Apply BEFORE its code is deployed: the auto-approve pass reads both columns
-- and skips a workspace whose read fails. See RUNBOOK.md.
--
-- Autopilot ships a draft that passes its checks after the hold window and
-- asks a person only on an exception (lib/publishing/auto-approve-exceptions.ts):
-- the first draft on a site, health/legal/money advice, a price the site never
-- states, a named competitor, a page type never published there, two failed
-- publishes. A site may turn four of them off (decision D5, 2026-10-16):
--
-- 1. workspaces.auto_approve_exceptions: a map of rule to `false`, e.g.
--    {"price": false}. A missing key is a rule that is on. Written by the
--    server only (app/actions/auto-approve-exceptions.ts), after its own
--    check: health, legal and money advice can be turned off only once the
--    site has 5 approvals that went out unedited. A signed-in client that
--    changes it is refused (42501), like 109's auto_approve_set_by.
--
-- 2. articles.person_edited_at: the last time a signed-in user changed the
--    body or the title. Stamped by the trigger below, never taken from the
--    client: the editor's Save (app/actions/articles.ts) writes the text with
--    the person's own token, and that write is what stamps it. The server
--    (generation, the fact check, publishing: no auth.uid()) does not stamp
--    it. D5's "approvals that went out unedited" are human approvals that
--    went live with no stamp before they went out.
--
--    Edits were never recorded before this file, so approved rows that exist
--    now are set to '-infinity': "not known", which the count reads as
--    edited. Only approvals from here on count towards the 5.
--
-- Idempotent: `add column if not exists`, guarded constraint and backfill,
-- create or replace, drop-then-create each trigger. Rollback in RUNBOOK.md.

alter table public.workspaces
  add column if not exists auto_approve_exceptions jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'workspaces_auto_approve_exceptions_object') then
    alter table public.workspaces
      add constraint workspaces_auto_approve_exceptions_object
      check (jsonb_typeof(auto_approve_exceptions) = 'object');
  end if;
end $$;

comment on column public.workspaces.auto_approve_exceptions is
  'Exception rules this site turned off for automatic approval: {"sensitive"|"price"|"competitor"|"page_type": false}. Missing = on. Written by the server only (workspaces_guard_auto_approve_exceptions). Read by lib/publishing/auto-approve.ts.';

alter table public.articles
  add column if not exists person_edited_at timestamptz;

comment on column public.articles.person_edited_at is
  'When a signed-in user last changed this article''s body or title; null when nobody has. Stamped by articles_stamp_person_edit, never written by a client. ''-infinity'' on rows approved before migration 119: edits were not recorded then.';

-- Only rows the clean-approval count reads, and only once: a row the trigger
-- has stamped since is left alone.
update public.articles
   set person_edited_at = '-infinity'
 where approved_at is not null
   and person_edited_at is null
   and not exists (select 1 from pg_trigger where tgname = 'articles_stamp_person_edit');

-- caller: internal (trigger only - see the REVOKE below)
create or replace function public.workspaces_guard_auto_approve_exceptions()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if pg_trigger_depth() = 0 then
    raise exception 'workspaces_guard_auto_approve_exceptions is a trigger function'
      using errcode = '42501';
  end if;

  -- The server, psql, and the database's own cascades.
  if auth.uid() is null or pg_trigger_depth() > 1 then
    return new;
  end if;

  if (tg_op = 'INSERT' and new.auto_approve_exceptions <> '{}'::jsonb)
     or (tg_op = 'UPDATE' and new.auto_approve_exceptions is distinct from old.auto_approve_exceptions)
  then
    raise exception 'Which exception rules a site turns off is saved by AltoRank, not by a signed-in user'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke execute on function public.workspaces_guard_auto_approve_exceptions() from public, anon, authenticated;

drop trigger if exists workspaces_guard_auto_approve_exceptions on public.workspaces;
create trigger workspaces_guard_auto_approve_exceptions
  before insert or update on public.workspaces
  for each row execute function public.workspaces_guard_auto_approve_exceptions();

-- caller: internal (trigger only - see the REVOKE below)
create or replace function public.articles_stamp_person_edit()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if pg_trigger_depth() = 0 then
    raise exception 'articles_stamp_person_edit is a trigger function'
      using errcode = '42501';
  end if;

  -- The server, psql, and cascades write what they write.
  if auth.uid() is null or pg_trigger_depth() > 1 then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- An article a person starts is theirs, not an unedited draft.
    new.person_edited_at := now();
  elsif new.content is distinct from old.content or new.title is distinct from old.title then
    new.person_edited_at := now();
  else
    new.person_edited_at := old.person_edited_at;
  end if;

  return new;
end;
$$;

revoke execute on function public.articles_stamp_person_edit() from public, anon, authenticated;

drop trigger if exists articles_stamp_person_edit on public.articles;
create trigger articles_stamp_person_edit
  before insert or update on public.articles
  for each row execute function public.articles_stamp_person_edit();
