-- 076: onboarding runs, so the first run survives its request
-- Depends on: 001_initial_schema (agencies, workspaces, articles), 053_workspace_roles (user_workspace_ids)
--
-- Onboarding used to run inside one SSE request (/api/onboard/stream): read
-- the site, find keywords, schedule the month, write the first draft, all
-- while the browser held the connection. The pipeline checked the request's
-- abort signal at every phase boundary, so a reload landed on wizard step 1
-- and stopped the run, a closed tab killed it, and the screen had to say
-- "keep this tab open". A slow draft (max 282s measured on prod) also pushed
-- the whole request at Vercel's 300s ceiling.
--
-- One row per run is now the source of truth. POST /api/onboard/start inserts
-- it and dispatches a worker (/api/onboard/run, CRON_SECRET-authed, its own
-- invocation); the worker writes `phases` after every event, hands the first
-- draft to /api/internal/draft in yet another invocation, and that route
-- stamps `article_id` and the terminal status. The screen polls
-- GET /api/onboard/state and folds the row through the same reducer the
-- stream's events went through, so it looks the same and survives a reload.
--
-- `phases` is the reducer's step list: [{phase, status, detail}], in
-- PHASE_ORDER. `planned` is [{term, date}]. Both are what the screen renders,
-- persisted verbatim, so a persisted run renders exactly as a live one did.
create table if not exists onboarding_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  agency_id uuid not null references agencies(id) on delete cascade,
  status text not null default 'running'
    check (status in ('running', 'done', 'partial', 'error')),
  phases jsonb not null default '[]'::jsonb,
  planned jsonb not null default '[]'::jsonb,
  -- Null until the keyword phase reports; never 0 for "not measured" (rule 5).
  keywords_found integer,
  -- The first draft, once /api/internal/draft has written it. Set null if the
  -- article is deleted: the run happened, the draft is simply gone.
  article_id uuid references articles(id) on delete set null,
  error text,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

-- One live run per workspace. /start returns the existing one rather than
-- inserting a second; a race between two starts loses here with 23505 and
-- re-reads the winner.
create unique index if not exists idx_onboarding_runs_one_running_per_workspace
  on onboarding_runs (workspace_id) where status = 'running';

-- "The latest run for this workspace", which /state and the wizard both ask.
create index if not exists idx_onboarding_runs_workspace_started
  on onboarding_runs (workspace_id, started_at desc);

alter table onboarding_runs enable row level security;

-- Members read their own sites' runs; nothing else. Every write comes from the
-- service role (start, worker, draft route), so there is no insert, update or
-- delete policy on purpose - the same posture as agent_idempotency_keys (069).
drop policy if exists "Onboarding runs by access" on onboarding_runs;
create policy "Onboarding runs by access" on onboarding_runs
  for select using (workspace_id in (select user_workspace_ids()));

comment on table onboarding_runs is
  'One row per onboarding run. Inserted by POST /api/onboard/start, advanced by the /api/onboard/run worker after every phase, finished by /api/internal/draft when the first draft lands. Read by GET /api/onboard/state and the wizard on reload.';
comment on column onboarding_runs.phases is
  'The progress screen''s step list, [{phase, status, detail}] in PHASE_ORDER, persisted after every event so a reload renders what the stream would have.';
comment on column onboarding_runs.status is
  'running until the draft route or the worker finishes it: done (plan + draft), partial (something fell short, the phases say what), error (the worker itself threw; see error).';
