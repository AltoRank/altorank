-- 123: what a first look read, kept so the run can be replayed for free.
--
-- A first look's results pages lived only in the worker's memory. When
-- several signups planned nothing in one evening (2026-11-16) there was no
-- way to see what the planner had been shown without buying every page
-- again. One row per onboarding run now keeps the topics each ask returned
-- and every results page read, compact: the search, the page-type reading
-- and the judged results with their kinds
-- (apps/web/lib/onboarding/first-look-replay.ts).
--
-- Server only, like run_budgets (106) and gate_visits (121): written by the
-- onboarding worker through the service role, read by an operator. RLS is on
-- with no policy, and nothing is granted to anon or authenticated.
--
-- Apply BEFORE its code is deployed. The code tolerates the table being
-- absent (the write is best effort and logs a warning), so the order only
-- decides whether the first runs after the deploy are kept.

create table if not exists public.first_look_replays (
  run_id uuid primary key references public.onboarding_runs(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  version integer not null default 1,
  language_code text not null,
  location_code integer not null,
  outcome text not null,
  rung text,
  asked jsonb not null default '{"suggested": [], "secondAsk": []}'::jsonb,
  pages jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists first_look_replays_workspace_idx
  on public.first_look_replays (workspace_id, created_at desc);

comment on table public.first_look_replays is
  'One row per onboarding run: the topics a first look was offered and the results pages it read, so the run can be replayed without buying them again. Server-written only (migration 123).';

alter table public.first_look_replays enable row level security;
revoke all on table public.first_look_replays from anon, authenticated;
grant select, insert, update, delete on table public.first_look_replays to service_role;
