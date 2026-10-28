-- 120: a blog AltoRank hosts for the site
--
-- No customer can publish anywhere self-serve without a CMS connection, so
-- every article ends in copy-paste. AltoRank hosts the blog itself instead:
-- first at a preview path (app.altorank.co/b/<slug>), then at the
-- customer's own blog.<domain> by CNAME.
--
--   hosted_blog_slug         the preview path's segment. Lowercase letters,
--                            digits and hyphens; one site per slug. Null until
--                            the blog is turned on.
--   hosted_blog_host         the customer's own host (blog.example.com) once
--                            they enter it. One site per host: the
--                            middleware will map a Host header to exactly one site.
--   hosted_blog_status       off          nothing is served; /b/<slug> is a 404
--                            preview      served at the preview path, noindex
--                            pending_dns  host entered, CNAME not seen yet
--                            verified     host verified; the canonical moves there
--   hosted_blog_verified_at  when the host was last verified.
--
-- All four are written by AltoRank only (the service role). A signed-in user
-- who could write them could point a verified host at their own site, or
-- claim another site's slug. Nothing here grants them: since 100, a column
-- added to `workspaces` is writable by no client token until its migration
-- grants it, the same rule that keeps the trial columns server-written. The
-- revoke below only says so out loud, and keeps saying it should a later
-- migration re-run 100's grant over every column.
alter table public.workspaces
  add column if not exists hosted_blog_slug text,
  add column if not exists hosted_blog_host text,
  add column if not exists hosted_blog_status text not null default 'off',
  add column if not exists hosted_blog_verified_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'workspaces_hosted_blog_slug_check') then
    alter table public.workspaces add constraint workspaces_hosted_blog_slug_check
      check (hosted_blog_slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'workspaces_hosted_blog_host_check') then
    alter table public.workspaces add constraint workspaces_hosted_blog_host_check
      check (hosted_blog_host = lower(hosted_blog_host) and hosted_blog_host ~ '^[a-z0-9.-]+$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'workspaces_hosted_blog_status_check') then
    alter table public.workspaces add constraint workspaces_hosted_blog_status_check
      check (hosted_blog_status in ('off', 'preview', 'pending_dns', 'verified'));
  end if;
end $$;

create unique index if not exists workspaces_hosted_blog_slug_key
  on public.workspaces (hosted_blog_slug) where hosted_blog_slug is not null;
create unique index if not exists workspaces_hosted_blog_host_key
  on public.workspaces (hosted_blog_host) where hosted_blog_host is not null;

comment on column public.workspaces.hosted_blog_slug is
  'The hosted blog''s preview path segment (/b/<slug>). Lowercase [a-z0-9-], unique. Null until the blog is turned on. Written by AltoRank only.';
comment on column public.workspaces.hosted_blog_host is
  'The customer''s own host for the hosted blog (blog.example.com), lowercase, unique. Written by AltoRank only.';
comment on column public.workspaces.hosted_blog_status is
  'off | preview | pending_dns | verified. off serves nothing; preview serves /b/<slug> noindex; verified moves the canonical to hosted_blog_host. Written by AltoRank only.';
comment on column public.workspaces.hosted_blog_verified_at is
  'When hosted_blog_host was last verified. Written by AltoRank only.';

revoke update (hosted_blog_slug, hosted_blog_host, hosted_blog_status, hosted_blog_verified_at)
  on public.workspaces from anon, authenticated;
