-- 109: an approval is written by the server, never by a signed-in user's client
-- Depends on: 002_backend_additions (articles.meta_description),
-- 003_publishing_schedule (scheduled_at), 005_featured_images
-- (featured_image_url), 013_approval_workflow (approved_by, approved_at),
-- 079_auto_approve (approval_kind, held_by, held_at; workspaces.auto_approve_*),
-- 094_found_on_site (found_on_site_at, found_on_site_prior). Nothing in
-- 097-105: it adds two triggers of its own and replaces no function.
-- Apply AFTER its code is live, like 097 and 099: see RUNBOOK.md.
--
-- The publish gate (apps/web/lib/publishing/core.ts) ships an article that is
-- `approved` or `scheduled` with `approved_by` set. Those columns were
-- writable by any member over PostgREST: "Articles by access" (053) is FOR ALL
-- on site membership, and 097 kept INSERT and UPDATE granted on the whole
-- table. So a member could PATCH `{status: 'scheduled', approved_by: <any
-- colleague>}` onto a draft and the publish cron would push it under that
-- colleague's name, skipping the approve action's checks (an active plan, no
-- unsourced figure). The app's own actions now write every approval with the
-- service role after their checks (app/actions/publish.ts, schedule.ts,
-- lib/publishing/retry.ts, lib/found-on-site/undo.ts), and the publish's own
-- `live` is written the same way (lib/publishing/core.ts).
--
-- This trigger holds a signed-in user (`auth.uid()` set) to that:
--
-- 1. No client token makes an article approved, scheduled or live, or sets
--    approved_by, approved_at, approval_kind or scheduled_at to a value. An
--    INSERT may not start in any of those states either. Nor does it set
--    found_on_site_at or found_on_site_prior: those are the nightly check's
--    record of the state before a find, and "Not my article" puts that state
--    back with the server's client. A client that could write the record
--    could put `approved` in it on any live article, edit the text, and have
--    the undo hand it back approved under the original approver's name.
-- 2. Clearing is allowed, and a client token that moves an article to any
--    other status takes the approval with it: approved_by, approved_at,
--    approval_kind and scheduled_at are set to null. That is what Request
--    changes, Cancel schedule, Unpublish and Change status mean, and it keeps
--    a stale approval from riding along on a draft that is later retried.
-- 3. An edit to the text of an approved or scheduled article, or of one whose
--    publish failed with its approval kept for the retry (content, title,
--    slug, meta_description, featured_image_url) or of the site it goes to
--    (workspace_id: an approval is for one site), voids the approval: the
--    article goes back to `review`, held by the editor, so nobody's sign-off
--    covers words they never read. The editor's Save does the same
--    (app/actions/articles.ts); this is the same rule for any other client
--    write. A live article's text is not touched by this: changing it
--    changes nothing on the site until it is approved and published again.
--
-- Like 099-102, it passes the service role (no `auth.uid()`: the server, the
-- crons, psql) and a change the database makes itself (`pg_trigger_depth() >
-- 1`, such as a foreign key's `on delete set null` on held_by).
--
-- Idempotent: create or replace, drop-then-create each trigger. Rollback in
-- RUNBOOK.md.

-- caller: internal (trigger only - see the REVOKE below)
create or replace function public.articles_guard_approval()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if pg_trigger_depth() = 0 then
    raise exception 'articles_guard_approval is a trigger function'
      using errcode = '42501';
  end if;

  -- The server, psql, and the database's own cascades.
  if auth.uid() is null or pg_trigger_depth() > 1 then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status in ('approved', 'scheduled', 'live')
       or new.approved_by is not null
       or new.approved_at is not null
       or new.approval_kind is not null
       or new.scheduled_at is not null
       or new.found_on_site_at is not null
       or new.found_on_site_prior is not null
    then
      raise exception 'An article is approved, scheduled or published by AltoRank, not by a signed-in user'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if (new.status is distinct from old.status and new.status in ('approved', 'scheduled', 'live'))
     or (new.approved_by is not null and new.approved_by is distinct from old.approved_by)
     or (new.approved_at is not null and new.approved_at is distinct from old.approved_at)
     or (new.approval_kind is not null and new.approval_kind is distinct from old.approval_kind)
     or (new.scheduled_at is not null and new.scheduled_at is distinct from old.scheduled_at)
     or (new.found_on_site_at is not null and new.found_on_site_at is distinct from old.found_on_site_at)
     or (new.found_on_site_prior is not null and new.found_on_site_prior is distinct from old.found_on_site_prior)
  then
    raise exception 'An article is approved, scheduled or published by AltoRank, not by a signed-in user'
      using errcode = '42501';
  end if;

  -- Approved text edited: back to review, held by whoever edited it.
  if new.status is not distinct from old.status
     and (old.status in ('approved', 'scheduled') or (old.status = 'error' and old.approved_by is not null))
     and (new.content is distinct from old.content
          or new.title is distinct from old.title
          or new.slug is distinct from old.slug
          or new.meta_description is distinct from old.meta_description
          or new.featured_image_url is distinct from old.featured_image_url
          or new.workspace_id is distinct from old.workspace_id)
  then
    new.status := 'review';
    new.held_by := auth.uid();
    new.held_at := now();
  end if;

  -- Out of a state by a person's hand: the approval goes with it.
  if new.status is distinct from old.status then
    new.approved_by := null;
    new.approved_at := null;
    new.approval_kind := null;
    new.scheduled_at := null;
  end if;

  return new;
end;
$$;

revoke execute on function public.articles_guard_approval() from public, anon, authenticated;

drop trigger if exists articles_guard_approval on public.articles;
create trigger articles_guard_approval
  before insert or update on public.articles
  for each row execute function public.articles_guard_approval();

-- ---------------------------------------------------------------------------
-- The auto-approve rule is the person who set it
-- ---------------------------------------------------------------------------
--
-- The publish cron writes every automatic approval with
-- `approved_by = workspaces.auto_approve_set_by` (lib/publishing/auto-approve.ts).
-- That column was writable by any member over PostgREST (100 left UPDATE
-- granted on it), so a member could PATCH `{auto_approve: true,
-- auto_approve_set_by: <a colleague>, auto_approve_min_seo: 0}` and every
-- draft would then publish approved in the colleague's name. For a signed-in
-- user:
--
-- 4. auto_approve_set_by may be set only to the caller (or cleared).
-- 5. Turning the rule on, or changing its hold or floors while it is on,
--    records the caller as the one who set it, whatever the write said.
--    That is what the app's own setAutoApprove writes (app/actions/workspaces.ts),
--    so it is unaffected.
--
-- Same exemptions as the articles trigger: the service role and cascades.

-- caller: internal (trigger only - see the REVOKE below)
create or replace function public.workspaces_guard_auto_approve()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if pg_trigger_depth() = 0 then
    raise exception 'workspaces_guard_auto_approve is a trigger function'
      using errcode = '42501';
  end if;

  if auth.uid() is null or pg_trigger_depth() > 1 then
    return new;
  end if;

  if new.auto_approve_set_by is not null
     and new.auto_approve_set_by is distinct from old.auto_approve_set_by
     and new.auto_approve_set_by <> auth.uid()
  then
    raise exception 'Auto-approve is recorded as set by the person who sets it'
      using errcode = '42501';
  end if;

  if new.auto_approve
     and (not old.auto_approve
          or new.auto_approve_hold_hours is distinct from old.auto_approve_hold_hours
          or new.auto_approve_min_seo is distinct from old.auto_approve_min_seo
          or new.auto_approve_min_aeo is distinct from old.auto_approve_min_aeo)
  then
    new.auto_approve_set_by := auth.uid();
    new.auto_approve_set_at := now();
  end if;

  return new;
end;
$$;

revoke execute on function public.workspaces_guard_auto_approve() from public, anon, authenticated;

drop trigger if exists workspaces_guard_auto_approve on public.workspaces;
create trigger workspaces_guard_auto_approve
  before update on public.workspaces
  for each row execute function public.workspaces_guard_auto_approve();
