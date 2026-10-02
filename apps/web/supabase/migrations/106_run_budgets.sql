-- 106: a first look's dollar is reserved before it is spent, and its spend says which stage bought it
-- Depends on: 025_provider_spend, 076_onboarding_runs. Independent of 097-105.
-- Apply BEFORE its code is deployed: see RUNBOOK.md. The new code opens a
-- budget row for every onboarding run and asks `run_budget_claim` before
-- every paid call of the first look; on a database without this file the
-- row cannot be written, so the run is bounded in the worker's memory
-- instead (and says so in the log), the draft is held to its reserve, and
-- spend rows lose their stage. Old code never reads the table
-- or the column, so applying early changes nothing.
--
-- The first look had a $1 ceiling (founder decision 2026-09-29) that was
-- checked after the fact: qualification summed provider_spend for the site
-- since the run started and stopped once that sum crossed the line. Three
-- things were wrong with it, all seen on live runs:
--
-- 1. It was a check, not a reservation. Calls in flight were not counted,
--    so a batch of three results pages and six model reads could all pass
--    the check together and land above it: 2 of 9 live runs closed at $1.031
--    and $1.004.
-- 2. The draft is written in its own invocation (/api/internal/draft), so
--    "less the draft's share" was a number qualification subtracted, not
--    money anything held back.
-- 3. Spend was attributed through a process-global reporter
--    (lib/seo/client.ts setSpendReporter), so two runs in one process billed
--    each other's calls, and one run's overage could not be attributed.
--
-- So each run gets a row here, and every paid call claims its estimate from
-- it first, in one locked update:
--
-- `ceiling_usd`    the run's total, the draft included.
-- `reserves`       {stage: usd} held back for one stage: `draft` ($0.43: the writer's
--                  floor and the draft's research, sized in
--                  lib/billing/run-budget.ts) and `outline_swap` ($0.05). Any other stage sees the ceiling
--                  less what those stages have not yet used; the stage itself
--                  may also use whatever the others left.
-- `committed_usd`  open claims at their estimate plus settled claims at what
--                  the provider charged. Never above the ceiling at claim
--                  time; a settle moves it by (actual - estimate).
-- `stages`         {stage: {committed, spent, calls, refused}}: the per-stage
--                  split the first look's funnel event reports.
--
-- A refused claim buys nothing: the caller leaves that item not judged (or
-- the draft not written) and the run carries on with what it has.
--
-- And `provider_spend.stage`: which stage of a first look bought the row
-- (voice, profile, discovery, buyer_fit, results_pages, judge,
-- questions, draft - the draft's related-keyword lookup included; `other`
-- when untagged). Null outside
-- a first look. A first look's rows, the draft's included, carry the
-- onboarding run's id in `run_id`.
--
-- Idempotent: `if not exists` throughout and `create or replace` for the
-- functions. Rollback in RUNBOOK.md.

alter table public.provider_spend add column if not exists stage text;

comment on column public.provider_spend.stage is
  'Which stage of a first look bought this call (voice, profile, discovery, buyer_fit, results_pages, judge, questions, draft; other when untagged). Null outside a first look (migration 106).';
comment on column public.provider_spend.run_id is
  'Groups the calls of one piece of work: the onboarding run for every row of a first look, the draft included; the generation job otherwise.';

create index if not exists idx_provider_spend_run_stage
  on public.provider_spend (run_id, stage) where stage is not null;

create table if not exists public.run_budgets (
  run_id uuid primary key references public.onboarding_runs(id) on delete cascade,
  workspace_id uuid references public.workspaces(id) on delete set null,
  ceiling_usd numeric(10, 6) not null check (ceiling_usd >= 0),
  reserves jsonb not null default '{}'::jsonb,
  committed_usd numeric(10, 6) not null default 0,
  stages jsonb not null default '{}'::jsonb,
  refused integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.run_budgets is
  'One onboarding run''s spend budget: every paid call of the first look claims its estimate here before it is made (migration 106). Server only.';

-- Server only: the worker and the draft route hold the service role. No
-- policy, so a client token reads and writes nothing.
alter table public.run_budgets enable row level security;
revoke all on table public.run_budgets from anon, authenticated;
grant select, insert, update, delete on table public.run_budgets to service_role;

-- caller: internal (run_budget_claim, and lib/billing/run-budget.ts room())
-- What a stage may still claim: the ceiling less everything committed less
-- the reserves other stages have not used yet. Null when the run has no
-- budget row.
create or replace function public.run_budget_room(p_run_id uuid, p_stage text)
returns numeric
language sql
stable
set search_path to 'public'
as $$
  select b.ceiling_usd - b.committed_usd - coalesce((
    select sum(greatest(0, (r.value #>> '{}')::numeric - coalesce((b.stages -> r.key ->> 'committed')::numeric, 0)))
      from jsonb_each(b.reserves) r
     where r.key <> p_stage
  ), 0)
  from public.run_budgets b
  where b.run_id = p_run_id;
$$;

-- caller: lib/billing/run-budget.ts (claim), service role only
-- Claim up to p_want for p_stage, never less than p_min (default p_want).
-- Returns what was granted, or null when the room is below p_min: refused,
-- counted on the row, nothing committed. Raises when the run has no budget.
-- The row lock makes concurrent claims of one run take turns, so the room
-- each one sees already holds the others' claims.
create or replace function public.run_budget_claim(p_run_id uuid, p_stage text, p_want numeric, p_min numeric default null)
returns numeric
language plpgsql
set search_path to 'public'
as $$
declare
  v_min numeric := coalesce(p_min, p_want);
  v_room numeric;
  v_grant numeric;
  v_stage jsonb;
begin
  if p_stage is null or p_want is null or p_want < 0 or v_min < 0 or v_min > p_want then
    raise exception 'run_budget_claim: bad claim (stage %, want %, min %)', p_stage, p_want, v_min
      using errcode = '22023';
  end if;

  perform 1 from public.run_budgets where run_id = p_run_id for update;
  if not found then
    raise exception 'run_budget_claim: no budget for run %', p_run_id using errcode = 'P0002';
  end if;

  v_room := public.run_budget_room(p_run_id, p_stage);
  v_grant := least(p_want, v_room);

  select coalesce(stages -> p_stage, '{}'::jsonb) into v_stage from public.run_budgets where run_id = p_run_id;

  if v_grant < v_min then
    update public.run_budgets
       set refused = refused + 1,
           stages = jsonb_set(stages, array[p_stage], v_stage || jsonb_build_object('refused', coalesce((v_stage ->> 'refused')::int, 0) + 1)),
           updated_at = now()
     where run_id = p_run_id;
    return null;
  end if;

  update public.run_budgets
     set committed_usd = committed_usd + v_grant,
         stages = jsonb_set(stages, array[p_stage], v_stage || jsonb_build_object('committed', coalesce((v_stage ->> 'committed')::numeric, 0) + v_grant)),
         updated_at = now()
   where run_id = p_run_id;
  return v_grant;
end
$$;

-- caller: lib/billing/run-budget.ts (settle), service role only
-- Replace a granted claim with what the provider charged. A null actual (the
-- provider reported no price) keeps the claim at its estimate. Never fails
-- for a run whose budget row is gone.
create or replace function public.run_budget_settle(p_run_id uuid, p_stage text, p_granted numeric, p_actual numeric)
returns void
language plpgsql
set search_path to 'public'
as $$
declare
  v_spent numeric := greatest(0, coalesce(p_actual, p_granted));
  v_stage jsonb;
begin
  if p_stage is null or p_granted is null or p_granted < 0 then
    raise exception 'run_budget_settle: bad settle (stage %, granted %)', p_stage, p_granted using errcode = '22023';
  end if;
  select coalesce(stages -> p_stage, '{}'::jsonb) into v_stage from public.run_budgets where run_id = p_run_id for update;
  if not found then
    return;
  end if;
  update public.run_budgets
     set committed_usd = committed_usd + (v_spent - p_granted),
         stages = jsonb_set(stages, array[p_stage], v_stage || jsonb_build_object(
           'committed', coalesce((v_stage ->> 'committed')::numeric, 0) + (v_spent - p_granted),
           'spent', coalesce((v_stage ->> 'spent')::numeric, 0) + v_spent,
           'calls', coalesce((v_stage ->> 'calls')::int, 0) + 1)),
         updated_at = now()
   where run_id = p_run_id;
end
$$;

revoke execute on function public.run_budget_room(uuid, text) from public, anon, authenticated;
revoke execute on function public.run_budget_claim(uuid, text, numeric, numeric) from public, anon, authenticated;
revoke execute on function public.run_budget_settle(uuid, text, numeric, numeric) from public, anon, authenticated;
grant execute on function public.run_budget_room(uuid, text) to service_role;
grant execute on function public.run_budget_claim(uuid, text, numeric, numeric) to service_role;
grant execute on function public.run_budget_settle(uuid, text, numeric, numeric) to service_role;
