-- 078: what is mechanically wrong with a page the customer already published
-- Depends on: 044_site_pages (the table), 046_site_pages_type (page_type)
--
-- The wizard asks a new customer for their blog and tells them what it is for.
-- Nothing read it. `detectLinks` harvested its URLs into the link pool and the
-- only thing that ever fetched the pages themselves was `cron/site-pages`,
-- which is gated on `first_analysed_at` and runs one workspace a night - so on
-- day one `site_pages` was empty and the product knew nothing about the 204
-- posts it had just been told about.
--
-- Onboarding now crawls those pages itself and records a technical assessment
-- of each one. Technical, and not editorial: a status code, the length of a
-- title, how many H1 there are, whether a canonical points at the page it is
-- on. No model and no paid API is involved - the crawl is a plain GET and the
-- checks are regular expressions over the response - so this costs bandwidth
-- and nothing else. The editorial judgement about the same page already lives
-- one column over in `audit`, needs a keyword, and is a different question.
--
-- Three columns rather than a table. A finding belongs to exactly one page,
-- has no lifecycle of its own (no dismissal, no assignment, no history), and
-- is rewritten wholesale by the next crawl. A `site_page_findings` table would
-- add a join and a delete-then-insert to every crawl for a list that is read
-- as a list.

alter table site_pages add column if not exists tech_findings jsonb;
alter table site_pages add column if not exists tech_issue_count integer;
alter table site_pages add column if not exists tech_checked_at timestamptz;

comment on column site_pages.tech_findings is
  'Technical findings for this page, as [{code, severity, message}]. NULL means nobody has checked it; [] means checked and clean - and the two must stay distinguishable or an unchecked site reads as a perfect one.';
comment on column site_pages.tech_issue_count is
  'jsonb_array_length(tech_findings), denormalised so the dashboard can count and sort without opening the jsonb. NULL alongside a NULL tech_findings.';
comment on column site_pages.tech_checked_at is
  'When the checks last ran on this page. Distinct from last_crawled_at, which moves whenever the page is fetched for any reason.';

-- The dashboard's one query: this site's pages that have something wrong,
-- worst first. Partial, because a site that has never been checked has no rows
-- here and should not be paid for in the index.
create index if not exists idx_site_pages_tech_issues
  on site_pages(workspace_id, tech_issue_count desc)
  where tech_issue_count is not null and tech_issue_count > 0;

-- No RLS change: 044's "Site pages by agency" policy is `for all` over the
-- whole row, so the new columns are already covered by it.
