-- 047: mark a page we had to render, and keep its provider score apart
-- Depends on: 044_site_pages
--
-- A client-rendered site returns a valid 200 with an empty shell, so our own
-- fetch reads nothing and `analyseDomain` reports "no pages could be crawled".
-- DataForSEO runs a real browser and can read those pages, at $0.0051 each
-- against nothing for a plain GET, so it is a fallback for pages we failed on
-- rather than a default.
--
-- What comes back is counts, headings and 52 checks - not markup. The SEO and
-- GEO scorers read markup: whether a table exists, whether a heading is a
-- question, whether a figure sits in a paragraph that cites its source. So a
-- rendered page keeps null scores and carries the provider's own number in a
-- separate column, because a score built on less evidence must not sit in the
-- same column as the others and look identical to them.

alter table site_pages add column if not exists rendered_by text
  check (rendered_by in ('dataforseo'));
alter table site_pages add column if not exists onpage_score integer;

comment on column site_pages.rendered_by is
  'Null when our own fetch read the page. Set when a browser was paid for because it could not, in which case seo_score and aeo_score are null and onpage_score carries the provider''s own 0-100 instead.';
