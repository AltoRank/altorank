-- 094: an article found live on the customer's own site
--
-- A real signup (2026-09-22) published one of our drafts on their own
-- hand-coded site 48 minutes after it was written, with no CMS connected.
-- Nothing recorded it, so every metric counted them as never having used a
-- draft and the lifecycle emails kept treating them as idle. The nightly check
-- in lib/found-on-site/ reads the site's sitemap for pages that are new since
-- a draft was written and compares their text with the draft's.
--
-- A match is recorded on the EXISTING publish record, not beside it: the
-- article becomes status = 'live' with published_url set to the page it was
-- found on - the same shape `markPublishedManually` writes when a person
-- pastes the URL themselves. That is what makes it count everywhere
-- "published" is already counted (reports, dashboard, calendar) and stop
-- every "your draft is waiting" nudge, all of which read `status`. One reader
-- of `status` deliberately does not take a find: the free allowance's
-- first-draft gate (lib/billing/first-draft-gate.ts), which waits for a
-- PERSON to review the first draft before unattended drafting goes on. A find
-- is a machine's comparison, and must not restart paid drafting for an account
-- that has not started its trial. The columns below only say HOW it went live
-- and how to take it back:
--
--   found_on_site_at        when the nightly check found it. Set means
--                           "Live on your site" (we found it), as distinct
--                           from live because AltoRank pushed it.
--   found_on_site_evidence  what the comparison measured: text containment,
--                           title similarity, the rule that decided, the
--                           sitemap lastmod. Shown to the person, so the claim
--                           carries its working.
--   found_on_site_prior     status, published_url and published_at as they
--                           were before, so "that is not my article" restores
--                           exactly what was there (an approved article held
--                           as a draft on a CMS has its own URL to get back).
--   found_on_site_rejected  pages a person said are not this article. The
--                           check never matches them to it again.
--
-- No publish_log row is written for a find. publish_log is the log of pushes
-- through a connection, and cron/publish reads its latest success as "this
-- workspace already published today" - a page the customer published by hand
-- must not skip the day's scheduled post.
alter table public.articles
  add column if not exists found_on_site_at timestamptz,
  add column if not exists found_on_site_evidence jsonb,
  add column if not exists found_on_site_prior jsonb,
  add column if not exists found_on_site_rejected text[] not null default '{}';

comment on column public.articles.found_on_site_at is
  'When the nightly found-on-site check (lib/found-on-site) found this article live on the customer''s own site. Non-null with status = live means "Live on your site": found there, not published through AltoRank. Cleared when a person undoes it.';
comment on column public.articles.found_on_site_evidence is
  'What the found-on-site comparison measured: containment of the draft''s word runs in the page (0-1), title similarity (0-1), the deciding rule, the sitemap lastmod.';
comment on column public.articles.found_on_site_prior is
  'status, published_url and published_at before the find, restored verbatim when a person says the page is not this article.';
comment on column public.articles.found_on_site_rejected is
  'Pages a person said are not this article. The nightly check never matches them to it again.';

-- Fair turns across nights: the check visits workspaces least-recently-checked
-- first, the same self-healing order cron/site-pages uses for its crawl.
alter table public.workspaces
  add column if not exists found_on_site_checked_at timestamptz;

comment on column public.workspaces.found_on_site_checked_at is
  'When the nightly found-on-site check last visited this workspace. Null = never; nulls go first.';

-- Why the check cannot see new pages on this site, when it cannot. A site
-- with no readable sitemap, a robots.txt that does not answer or forbids
-- every page, or pages whose text arrives by JavaScript would otherwise count
-- as "checked, nothing found" - and a copy published there would never be
-- found while the product said nothing. The Publish panel turns the code into
-- a sentence (lib/found-on-site/state.ts, BLIND_REASON). Null = the last
-- visit could see the site, or there has been none.
alter table public.workspaces
  add column if not exists found_on_site_unreadable text
    check (found_on_site_unreadable in ('robots-unanswered', 'robots-disallowed', 'no-sitemap', 'empty-sitemap', 'javascript'));

comment on column public.workspaces.found_on_site_unreadable is
  'Why the nightly found-on-site check cannot see new pages on this site: robots-unanswered, robots-disallowed, no-sitemap, empty-sitemap, javascript. Null = it can, or it has not looked.';

-- The ledger of pages read. One row per page per workspace, written by the
-- cron (service role) only. It is what keeps the check to twenty NEW pages a
-- night instead of the same twenty every night: a page read before is read
-- again only when its sitemap lastmod moves past `checked_at`.
--
-- Data class: internal. Public URLs of the customer's own site and our read
-- times; no personal data, no page text. RLS on with NO client policy - only
-- the service role reads or writes it (same shape as system_events, 082).
create table if not exists public.found_on_site_checks (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  url text not null,
  checked_at timestamptz not null default now(),
  -- The sitemap lastmod when the page was read, for the record.
  lastmod timestamptz,
  -- HTTP status of the read. A page that did not answer at all gets no row,
  -- so it is tried again the next night.
  status integer,
  -- Words of main content in the page as read, for an HTML page; null
  -- otherwise. Under the crawl's readable line (60) the page was a shell whose
  -- text arrives by JavaScript. It is not fetched again every night for the
  -- same shell; the workspace says the site cannot be seen instead.
  words integer,
  -- The article this page was found to be, when it was one.
  matched_article_id uuid references public.articles(id) on delete set null,
  primary key (workspace_id, url)
);

-- Read per workspace, all rows at once: the primary key is the index.
alter table public.found_on_site_checks enable row level security;
