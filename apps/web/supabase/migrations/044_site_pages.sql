-- 044: the pages a site already published, before AltoRank existed
-- Depends on: 001 (workspaces)
--
-- Everything the product knows about a customer's content, it wrote itself.
-- That is why the internal-link resolver returns nothing on a real site: a
-- link target is a live article in `articles`, and a customer who arrives
-- with 204 published posts has none of them there. Measured on fitsuite.co
-- 2026-09-04: 595 URLs in its sitemap, 204 of them blog posts, and the
-- homepage-first crawl in domain-analysis reached exactly two of them,
-- because posts sit past depth 2 behind a paginated index.
--
-- This table is those pages: discovered from the sitemap, fetched, scored
-- with the same three scorers a draft gets, and stored so that
--
--   1. the resolver can offer them as internal-link targets,
--   2. the first look can be about their content rather than their category,
--   3. pages ranking 8-30 with weak citation readiness become a refresh queue.
--
-- Deliberately NOT `articles`. That table means "something we wrote that went
-- through the approval gate", and 204 imported rows would flood the review
-- queue, confuse the quota, and make `status` meaningless.

create table if not exists site_pages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,

  url text not null,
  -- Pathname only, for grouping and for joining to ranked-keyword data, which
  -- reports the ranking URL in whatever form Google happened to return.
  path text not null,
  -- Cheap "has this changed since we last looked", so a re-crawl can skip
  -- rescoring what is byte-identical.
  content_hash text,

  title text,
  meta_description text,
  h1 text,
  word_count integer,

  -- The term this page appears to target. `ranked` when the SERP told us (the
  -- best-positioned keyword DataForSEO reports for this exact URL), `heading`
  -- when it is inferred from the H1 with brand words removed. A score against
  -- a guessed keyword means less, so the source travels with it.
  keyword text,
  keyword_source text check (keyword_source in ('ranked', 'heading')),
  position integer,

  seo_score integer,
  seo_checks jsonb,
  aeo_score integer,
  aeo_checks jsonb,
  -- The audit findings, same shape the editor's SEO tab renders.
  audit jsonb,

  internal_links integer,
  external_links integer,

  published_at timestamptz,
  modified_at timestamptz,
  -- JSON-LD @type values found on the page: Article, FAQPage, Product...
  schema_types text[],

  -- 0 means no response came back; `error` says why.
  status integer,
  error text,

  first_seen_at timestamptz not null default now(),
  last_crawled_at timestamptz not null default now(),

  -- One row per URL per site. A re-crawl updates rather than accumulates.
  unique (workspace_id, url)
);

create index if not exists idx_site_pages_workspace on site_pages(workspace_id, last_crawled_at desc);
-- The refresh queue reads this: ranking, but not well enough.
create index if not exists idx_site_pages_opportunity on site_pages(workspace_id, position) where position is not null;

alter table site_pages enable row level security;

create policy "Site pages by agency" on site_pages
  for all using (
    workspace_id in (
      select id from workspaces where agency_id in (select user_agency_ids())
    )
  );

comment on table site_pages is
  'Pages a customer already published, discovered from their sitemap and scored with the same scorers a draft gets. Source of internal-link targets for content the product did not write.';

-- When this site's pages were last read, so the cron can round-robin rather
-- than re-crawling whoever happens to sort first.
alter table workspaces add column if not exists last_pages_crawl_at timestamptz;
