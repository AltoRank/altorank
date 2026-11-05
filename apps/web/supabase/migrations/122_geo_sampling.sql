-- 122: geo_runs, and sampled answers from the surfaces buyers actually use
-- Depends on: 020_ai_visibility (geo_prompts, geo_results), 053 (user_workspace_ids)
-- (119 and 120 are taken by open branches.)
--
-- 020 measured AI visibility through the model vendors' APIs (DataForSEO
-- llm_responses): one answer per prompt per engine, with web search forced on
-- and the answer capped at 700 tokens. That is not what a buyer sees in the
-- ChatGPT app or in Google's AI Mode, and one answer per cell cannot tell 0%
-- from 9%: AI answers change on nearly every run (SparkToro/Gumshoe, Jan 2026),
-- so a mention rate is a proportion estimated from many samples.
--
-- Now a sweep is a run. Each run plans prompts x surfaces x samples, queues
-- them on DataForSEO's standard queue (the ChatGPT and Gemini app scrapers and
-- Google AI Mode), and collects them over the following days. The run records
-- what it planned, what it captured and what failed, so a partial sweep is
-- reported as partial instead of passing for a complete one, and the settings
-- it ran with, so two runs are only compared when they measured the same thing.
--
-- Server-written (app/api/cron/geo through the service role); members read
-- their own workspaces' runs.

create table if not exists public.geo_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  status text not null default 'running' check (status in ('running', 'complete', 'partial')),
  planned integer not null check (planned >= 0),
  captured integer not null default 0 check (captured >= 0),
  failed integer not null default 0 check (failed >= 0),
  -- Surfaces, samples per prompt, location, language, brand and domain as run.
  settings jsonb not null default '{}'::jsonb,
  cost_usd numeric(10,5) not null default 0,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists idx_geo_runs_workspace on public.geo_runs(workspace_id, started_at desc);
-- The cron's work queue: every run still collecting.
create index if not exists idx_geo_runs_running on public.geo_runs(started_at) where status = 'running';

comment on table public.geo_runs is
  'One AI-visibility sweep: what it planned, captured and failed, and the settings it ran with. Server-written.';

alter table public.geo_runs enable row level security;
drop policy if exists "Geo runs by access" on public.geo_runs;
create policy "Geo runs by access" on public.geo_runs
  for select using (workspace_id in (select user_workspace_ids()));

-- A result is one sampled answer inside a run. Rows written before this have
-- no run and stay readable as legacy API probes.
alter table public.geo_results add column if not exists run_id uuid references public.geo_runs(id) on delete cascade;
alter table public.geo_results add column if not exists sample integer;
-- 'app' is the consumer product scraped as a buyer sees it; 'api' is the
-- model vendor's API (every row from before this file).
alter table public.geo_results add column if not exists surface text not null default 'api';
alter table public.geo_results add column if not exists status text not null default 'ok';
alter table public.geo_results add column if not exists task_id text;
-- The answer itself, so a classification can be checked by reading it.
alter table public.geo_results add column if not exists answer text;
-- Brands the answer named (the ChatGPT app reports them as entities), apart
-- from the domains it cited: Wikipedia is a source, not a competitor.
alter table public.geo_results add column if not exists brands jsonb not null default '[]'::jsonb;

alter table public.geo_results drop constraint if exists geo_results_surface_check;
alter table public.geo_results add constraint geo_results_surface_check check (surface in ('api', 'app'));
alter table public.geo_results drop constraint if exists geo_results_status_check;
alter table public.geo_results add constraint geo_results_status_check check (status in ('pending', 'ok', 'failed'));
alter table public.geo_results drop constraint if exists geo_results_engine_check;
alter table public.geo_results add constraint geo_results_engine_check
  check (engine in ('chat_gpt', 'claude', 'gemini', 'perplexity', 'google_ai_mode'));

create index if not exists idx_geo_results_run on public.geo_results(run_id);
create index if not exists idx_geo_results_pending on public.geo_results(checked_at) where status = 'pending';

comment on column public.geo_results.status is
  'pending: queued, not collected. failed: excluded from every rate. ok: a captured answer.';
comment on column public.geo_results.surface is
  'app = the consumer product as a buyer sees it; api = the vendor API (legacy rows).';

-- Samples per prompt per surface in each weekly run. Five is the default: ten
-- prompts on three surfaces is 150 answers a week, about $0.18 on the
-- standard queue, and four weeks pooled is 200 per surface.
alter table public.workspaces add column if not exists geo_samples integer not null default 5;
alter table public.workspaces drop constraint if exists workspaces_geo_samples_check;
alter table public.workspaces add constraint workspaces_geo_samples_check check (geo_samples between 1 and 30);
