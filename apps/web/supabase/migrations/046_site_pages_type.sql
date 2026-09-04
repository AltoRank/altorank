-- 046: tell an article from the index that lists articles
-- Depends on: 044_site_pages
--
-- The crawl scored every URL as if it were a piece of writing. On fitsuite.co
-- that meant /blog, /blog/de and /blog/fr - the section indexes, one per
-- language - came back with the keyword "blog" and GEO 14, sat at the top of
-- the "weakest pages" list where nobody could act on them, and dragged the
-- site average down with content that is not content.
--
-- An index is still a real page and still gets a row: it is part of the site
-- and its own title and metadata are worth knowing. It just is not scored,
-- is not offered as an internal-link target, and is not counted in an average
-- that is meant to describe the writing.

alter table site_pages add column if not exists page_type text
  check (page_type in ('article', 'listing', 'page'));

comment on column site_pages.page_type is
  'article = a piece of writing, scored. listing = an index of other pages, not scored. page = everything else (pricing, about, a tool).';

create index if not exists idx_site_pages_articles
  on site_pages(workspace_id, aeo_score) where page_type = 'article';
