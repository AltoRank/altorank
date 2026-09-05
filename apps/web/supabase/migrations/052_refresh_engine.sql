-- 052: the content refresh engine
-- Depends on: 001 (workspaces, articles, user_agency_ids), 044 (site_pages)
--
-- Everything the product wrote so far was new. This is the other half of the
-- job: finding pages that already rank but not well enough, rewriting them
-- against the evidence, and letting a person keep or reject each changed
-- block before anything reaches the site.
--
-- Three tables, one per stage, because the stages are decided by different
-- actors at different times:
--
--   refresh_candidates   what the detectors found. A URL with an opportunity
--                        and the numbers that justify it. Dismissable.
--   refresh_tasks        the decision to act, and when. A person schedules a
--                        candidate for a date; the cron runs it on the next
--                        enabled weekday on or after that date.
--   refresh_executions   what the rewrite produced: before, after, and the
--                        block-level hunks between them. Lands in
--                        `awaiting_review` and stays there until a person
--                        pushes it or rejects it.
--
-- There is deliberately no auto-push column, on any of the three. The only
-- write to a CMS is the "Push to site" action, which requires an execution
-- in `awaiting_review` and applies the reviewer's per-hunk decisions. A
-- machine may propose an edit to a live page; it may not make one.

create table if not exists refresh_candidates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  -- Which row the evidence was read against. A page we wrote has both; a page
  -- the site already had has only the site_page. Neither is required, since
  -- the URL is what a candidate is really about.
  site_page_id uuid references site_pages(id) on delete set null,
  article_id uuid references articles(id) on delete set null,
  url text not null,
  opportunity text not null check (opportunity in (
    'almost_there', 'ctr_gap', 'declining', 'content_gap', 'thin'
  )),
  -- The measurements behind the verdict, in the shape lib/refresh/detect.ts
  -- writes: { query, position, prev_position, clicks, prev_clicks,
  -- impressions, ctr, expected_ctr, word_count }. A field that was not
  -- measured is null, never 0.
  evidence jsonb not null,
  -- The plan for the rewrite: what to strengthen, which questions to add,
  -- what to keep. Written by a model from the evidence, editable by a person
  -- before the rewrite runs. Plain text, so the editor is a textarea.
  brief text,
  brief_status text not null default 'pending' check (brief_status in ('pending', 'ready', 'failed')),
  dismissed_at timestamptz,
  created_at timestamptz not null default now()
);

-- One open candidate per URL and opportunity. Dismissing one lets the
-- detector raise it again later if the numbers still say so, which is the
-- honest behaviour: "not now" is not "never".
create unique index if not exists idx_refresh_candidates_open
  on refresh_candidates(workspace_id, url, opportunity) where dismissed_at is null;
create index if not exists idx_refresh_candidates_workspace
  on refresh_candidates(workspace_id, created_at desc);

create table if not exists refresh_tasks (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references refresh_candidates(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  scheduled_for date not null,
  status text not null default 'scheduled' check (status in (
    'scheduled', 'running', 'done', 'failed', 'cancelled'
  )),
  error text,
  created_at timestamptz not null default now()
);

create index if not exists idx_refresh_tasks_due
  on refresh_tasks(workspace_id, scheduled_for) where status = 'scheduled';

create table if not exists refresh_executions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references refresh_tasks(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  -- { html, title, metaDescription } either side.
  before jsonb,
  after jsonb,
  -- [{ id, kind, before, after }] from lib/refresh/hunks.ts.
  hunks jsonb not null default '[]',
  -- [{ code, message, severity }] from lib/refresh/validate.ts, computed
  -- before review so the reviewer sees them beside the diff.
  validation_issues jsonb default '[]',
  review_status text not null default 'awaiting_review' check (review_status in (
    'awaiting_review', 'pushed', 'rejected'
  )),
  -- { decisions: { [hunkId]: 'accepted' | 'rejected' }, edited: { [hunkId]: html } }
  decisions jsonb not null default '{}',
  pushed_at timestamptz,
  published_url text,
  created_at timestamptz not null default now()
);

create index if not exists idx_refresh_executions_workspace
  on refresh_executions(workspace_id, created_at desc);

-- Per-site switch and schedule. Off by default: a rewrite spends a model call
-- and a slot of the site's article pace, so nothing runs until someone asks.
alter table workspaces add column if not exists refresh_enabled boolean not null default false;
-- 0 = Sunday .. 6 = Saturday, at most two. One rewrite per enabled day.
alter table workspaces add column if not exists refresh_days integer[] not null default '{}';
alter table workspaces add column if not exists refresh_last_analyzed_at timestamptz;

alter table workspaces drop constraint if exists workspaces_refresh_days_check;
alter table workspaces add constraint workspaces_refresh_days_check
  check (cardinality(refresh_days) <= 2 and refresh_days <@ array[0,1,2,3,4,5,6]);

comment on column workspaces.refresh_days is
  'Weekdays (0=Sun..6=Sat) on which the refresh cron may run one scheduled rewrite for this site. At most two. Each rewrite consumes one slot of the article pace.';

-- RLS, by agency, like every other workspace-scoped table.
alter table refresh_candidates enable row level security;
alter table refresh_tasks enable row level security;
alter table refresh_executions enable row level security;

drop policy if exists "Refresh candidates by agency" on refresh_candidates;
create policy "Refresh candidates by agency" on refresh_candidates
  for all using (
    workspace_id in (select id from workspaces where agency_id in (select user_agency_ids()))
  );

drop policy if exists "Refresh tasks by agency" on refresh_tasks;
create policy "Refresh tasks by agency" on refresh_tasks
  for all using (
    workspace_id in (select id from workspaces where agency_id in (select user_agency_ids()))
  );

drop policy if exists "Refresh executions by agency" on refresh_executions;
create policy "Refresh executions by agency" on refresh_executions
  for all using (
    workspace_id in (select id from workspaces where agency_id in (select user_agency_ids()))
  );

comment on table refresh_candidates is
  'Pages the detectors think a rewrite would help, with the Search Console evidence that says so. One open row per URL and opportunity.';
comment on table refresh_tasks is
  'A candidate somebody decided to act on, and the earliest date the cron may run it.';
comment on table refresh_executions is
  'What a rewrite produced. Always lands in awaiting_review; the only way out is a person pushing or rejecting it.';
