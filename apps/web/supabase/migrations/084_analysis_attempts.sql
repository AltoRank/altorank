-- 084: a first look that read nothing is an attempt, not a first look
-- Depends on: 001_initial_schema (workspaces, domain_audits)
--
-- `cron/analyze` selects `first_analysed_at is null`. `analyseDomain` stamped
-- that column on every run, failures included, on the reasoning that a domain
-- which cannot be reached must not be re-crawled for ever. The cost of that
-- shortcut, measured on production 2026-09-09: two of the eight workspaces -
-- both of them real signups - were marked analysed off a crawl that fetched
-- **zero** pages. With no topical profile the onboarding run skipped
-- keywords, pages, planning and drafting; with
-- `first_analysed_at` set, nothing would ever look at either domain again.
-- Both sites crawl fine on a retry (8/8 and 1/1 pages).
--
-- So the retry protection moves off "have we ever run" and onto "how many
-- times have we tried". `analysis_attempts` counts runs that read nothing;
-- once it reaches MAX_ANALYSIS_ATTEMPTS (lib/audit/first-look.ts, 4) the
-- workspace is stamped and left alone, which is the behaviour the old comment
-- wanted. `last_analysis_attempt_at` spaces the retries out.
--
-- Idempotent: `add column if not exists` and a backfill whose predicate is
-- false on a second run (it selects on `first_analysed_at is not null`, which
-- it clears).

alter table workspaces
  add column if not exists analysis_attempts integer not null default 0,
  add column if not exists last_analysis_attempt_at timestamptz;

comment on column workspaces.analysis_attempts is
  'Analysis runs that read nothing. Reset is never needed: a run that reads the site stamps first_analysed_at and the workspace leaves the first-look queue.';

-- The backfill: workspaces stamped `analysed` whose every recorded audit
-- crawled zero pages. `domain_audits.pages_crawled` is written by the same run
-- that stamps the column, so this is the exact set - not a heuristic. A
-- workspace with no audit row at all is left alone: it was stamped by the
-- cron's catch branch or by a path that keeps no evidence, and re-queueing it
-- on no evidence is how you re-crawl a dead domain for ever.
with unread as (
  select w.id, count(*) as attempts, max(a.completed_at) as last_attempt
  from workspaces w
  join domain_audits a on a.workspace_id = w.id
  where w.first_analysed_at is not null
  group by w.id
  having max(coalesce(a.pages_crawled, 0)) = 0
)
update workspaces w
set first_analysed_at = null,
    analysis_attempts = unread.attempts,
    last_analysis_attempt_at = unread.last_attempt
from unread
where w.id = unread.id;

-- The queue the cron reads: never looked at, attempts left, ordered so a
-- fresh signup is served before a retry.
create index if not exists idx_workspaces_first_look
  on workspaces (analysis_attempts, created_at)
  where first_analysed_at is null;
