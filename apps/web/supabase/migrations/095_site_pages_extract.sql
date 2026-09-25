-- 095: what a business says about itself, kept from the pages already fetched
-- Depends on: 044_site_pages
--
-- A real signup, 2026-09-22 (Turkish web/mobile agency). Onboarding read his
-- services page, his portfolio with named public projects, his about page and
-- his contact page, stored each one's title, and discarded the rest. The
-- writer was then given three profile fields and wrote an article that
-- marketed the category rather than him: nothing downstream could see what
-- he sells, what he has built, or where a reader contacts him.
--
-- This column keeps the minimal part of those pages while the HTML is in hand
-- (lib/audit/site-extract.ts): the page's role (home, offering, work, about,
-- contact, pricing), what it calls itself, an index page's headings and named
-- links, an about page's opening text, and the founding, team and location
-- statements the page actually makes. No second request and no model: it is
-- read off the same response the crawl already scores. The writer's "site
-- facts" are built from it (lib/content/site-facts.ts).
--
-- NULL means the page has no such role, answered 404/410, or was read before
-- this column existed; the next crawl of that page fills it. A crawl that
-- could not read the page (a timeout, a 429, a 5xx, a render-service read)
-- leaves the stored value alone, so a non-NULL extract always means the last
-- definitive answer for the page was a 2xx. The writer's facts and the
-- internal-link allowance count such a row as a page the site has even when
-- the latest crawl was rate-limited (lib/content/site-facts.ts,
-- lib/linking/targets.ts).
--
-- Both crawls write it. The sitemap crawl (lib/seo/site-crawl.ts) as before,
-- and now also the homepage-first link crawl in the first look
-- (lib/audit/domain-analysis.ts), because a hand-built site with no sitemap -
-- the signup above - is only ever reached by following its own links. Those
-- rows are inserted only for pages that answered 2xx and never overwrite a
-- row the sitemap crawl wrote; they carry no scores and no keyword, so the
-- link pool, the refresh queue and the technical report, which all filter on
-- those, are unchanged by them.

alter table site_pages add column if not exists extract jsonb;

comment on column site_pages.extract is
  'What this page says about the business, when it is the home, services, portfolio, about, contact or pricing page: {v, role, roleFrom, detail, name, headings, links, text, stated}. Shape: lib/audit/site-extract.ts (SitePageExtract). NULL for every other page, for a page that answered 404/410, and for pages read before migration 095. Left as it is when a crawl could not read the page (timeout, 429, 5xx), so non-NULL means the last definitive answer was 2xx.';

comment on table site_pages is
  'Pages of a customer''s own site that a crawl fetched: from their sitemap (scored with the same scorers a draft gets) or by following links from the homepage (unscored). Source of internal-link targets for content the product did not write, and of the facts the writer is given about the business.';

-- No RLS change: the "Site pages by access" policy (053) is `for all` over
-- the whole row, so the new column is already covered by it.
