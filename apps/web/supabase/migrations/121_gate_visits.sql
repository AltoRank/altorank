-- 121: gate_visits — one row per site per day the pre-trial gate was shown
-- Depends on: 001_initial_schema (workspaces), 082 (system_events, for the backfill), 085 (accounts)
-- (119 and 120 are taken by open branches.)
--
-- The onboarding.step events are kept once per site (lib/onboarding/
-- step-events.ts): `gate_shown` says when the gate was first shown and never
-- again, so nothing recorded that an owner came back to it, and a return was
-- shown the same wall as a first visit. The gate now greets a return ("Welcome back.
-- Your article is saved."), and that needs a recorded earlier visit, not the
-- article's age: an article written overnight by the cron is new to someone
-- who has been here before.
--
-- One row per site per UTC day is enough to tell a return from a reload and
-- to measure return conversion (visits on a later day against the trial).
-- system_events is a log the product does not read to decide anything
-- (082), so the visit lives here.
--
-- Server-written and server-read only (app/api/onboard/step, the onboarding
-- page through the service role, after the person's own client has read the
-- site): no policy, and nothing granted to anon or authenticated.

create table if not exists public.gate_visits (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  day date not null,
  seen_at timestamptz not null default now(),
  primary key (workspace_id, day)
);

comment on table public.gate_visits is
  'One row per site per UTC day the pre-trial gate was shown: what tells a return from a first visit. Server-written only (migration 121).';

alter table public.gate_visits enable row level security;
revoke all on table public.gate_visits from anon, authenticated;
grant select, insert, update, delete on table public.gate_visits to service_role;

-- The gates already shown: each site's first `gate_shown`, so an owner who
-- came before this shipped is greeted as returning on the next visit.
insert into public.gate_visits (workspace_id, account_id, day, seen_at)
select distinct on (e.workspace_id, (e.created_at at time zone 'utc')::date)
  e.workspace_id, w.account_id, (e.created_at at time zone 'utc')::date, e.created_at
from public.system_events e
join public.workspaces w on w.id = e.workspace_id
where e.source = 'onboarding.step'
  and e.context->>'step' = 'gate_shown'
  and e.workspace_id is not null
order by e.workspace_id, (e.created_at at time zone 'utc')::date, e.created_at
on conflict (workspace_id, day) do nothing;
