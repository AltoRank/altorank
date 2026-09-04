-- 055: the internal-link pool - where we look for pages, and which pages a draft may link to
-- Depends on: 044 (site_pages), 049 (workspaces.sitemap_url / blog_root_url)
--
-- A draft's internal links have been whatever `fetchLinkTargets` could see:
-- our own live articles, plus the pages `site_pages` had crawled and scored.
-- Both are derived, neither is configurable. A customer who wants a draft to
-- point at their pricing page, never at their careers page, and always with
-- the words "personal trainer app" as the anchor, had nowhere to say so.
--
-- Two tables, two questions:
--
--   link_sources   where we look. The sitemap, a blog index, or a single URL.
--                  Seeded from what onboarding found; the customer can add,
--                  disable or remove.
--   link_targets   what we link to. One row per page, with a 0-3 priority,
--                  preferred anchor texts, and an enabled switch. Detected
--                  rows come from a source; manual rows were typed in.
--
-- `site_page_id` joins a target to the crawled row when there is one, so the
-- title and keyword come from the page itself rather than from its slug.

create table if not exists link_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind text not null check (kind in ('sitemap', 'blog_root', 'manual_url')),
  url text not null,
  enabled boolean not null default true,
  last_detected_at timestamptz,
  -- Null until a detection has run. 0 means it ran and found nothing, which
  -- is a different thing from not having looked.
  pages_found integer,
  error text,
  created_at timestamptz not null default now(),
  unique (workspace_id, url)
);

create table if not exists link_targets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  url text not null,
  path text,
  title text,
  keyword text,
  -- 0 is ordinary; 3 is "link here whenever the subject comes up".
  priority integer not null default 0 check (priority between 0 and 3),
  -- Anchor texts the customer prefers. The resolver uses one when a draft
  -- links to this page.
  anchors text[] not null default '{}',
  source text not null check (source in ('detected', 'manual')),
  enabled boolean not null default true,
  site_page_id uuid references site_pages(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, url)
);

create index if not exists idx_link_sources_workspace on link_sources (workspace_id);
create index if not exists idx_link_targets_pool
  on link_targets (workspace_id, priority desc) where enabled;

alter table link_sources enable row level security;
alter table link_targets enable row level security;

create policy "Link sources by agency" on link_sources
  for all using (
    workspace_id in (select id from workspaces where agency_id in (select user_agency_ids()))
  );

create policy "Link targets by agency" on link_targets
  for all using (
    workspace_id in (select id from workspaces where agency_id in (select user_agency_ids()))
  );

comment on table link_sources is
  'Where internal-link detection looks for a site''s pages: its sitemap, a blog index, or a single URL.';
comment on table link_targets is
  'The pages a generated draft may link to, with priority and preferred anchors. Detected from link_sources or added by hand.';
comment on column link_sources.pages_found is
  'Pages the last detection found in this source. Null when it has never run; 0 when it ran and found none.';

-- Onboarding already asked for the sitemap and the blog root. They are the
-- first two sources, so nobody has to type them a second time.
insert into link_sources (workspace_id, kind, url)
  select id, 'sitemap', sitemap_url from workspaces where sitemap_url is not null
  on conflict (workspace_id, url) do nothing;

insert into link_sources (workspace_id, kind, url)
  select id, 'blog_root', blog_root_url from workspaces where blog_root_url is not null
  on conflict (workspace_id, url) do nothing;
