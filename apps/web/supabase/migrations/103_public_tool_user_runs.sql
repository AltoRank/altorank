-- 103: per-account daily run count for the paid public tools
-- Depends on: nothing (auth.users only). Independent of 091, which it sits
-- beside: 091 is the one shared budget for every caller, this is each
-- signed-in person's share of it.
-- Apply BEFORE its code is deployed: see RUNBOOK.md. Until it is applied,
-- every paid public tool answers `user_cap` for everyone (the reservation
-- fails closed when the RPC is missing).
--
-- The paid tools behind POST /api/public/tools/<slug> (kinds `ai` and `data`)
-- need a signed-in account with a confirmed email, and each account gets a
-- fixed number of successful runs per UTC day across all of them together
-- (lib/public-tools/user-runs.ts, env PUBLIC_TOOLS_USER_DAILY_RUNS).
--
-- One row per account per UTC day. A run is reserved before the tool runs and
-- released again if the tool then fails on our side or a provider's, so a
-- failed run does not count. An answer from the cache never reaches here.
--
-- Service role only: RLS on with no policies, and no grants to anon or
-- authenticated. The count is read and written by the API with the service
-- key; nothing a client token can reach touches it.

create table if not exists public.public_tool_user_runs (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  runs integer not null default 0 check (runs >= 0),
  primary key (user_id, day)
);

alter table public.public_tool_user_runs enable row level security;
revoke all on public.public_tool_user_runs from anon, authenticated;
grant all on public.public_tool_user_runs to service_role;

-- Atomic check-and-reserve. The upsert takes the row lock, and the WHERE on
-- the conflict branch means a run is only added while the count is below the
-- limit, so two concurrent requests cannot both take the last run.
--
-- Returns jsonb:
--   { "ok": true,  "day": "YYYY-MM-DD", "remaining": <runs left after this one> }
--   { "ok": false, "day": "YYYY-MM-DD", "remaining": 0 }
-- `day` is the UTC day the run was counted against; the release below takes
-- it back, so a run that fails across midnight is refunded to the right day.
create or replace function public.reserve_public_tool_user_run(
  p_user_id uuid,
  p_limit integer
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_runs integer;
begin
  if p_user_id is null then
    raise exception 'reserve_public_tool_user_run: missing user';
  end if;
  if p_limit is null or p_limit < 0 then
    raise exception 'reserve_public_tool_user_run: invalid limit';
  end if;
  if p_limit = 0 then
    return jsonb_build_object('ok', false, 'day', v_day, 'remaining', 0);
  end if;

  insert into public.public_tool_user_runs as r (user_id, day, runs)
  values (p_user_id, v_day, 1)
  on conflict (user_id, day) do update
    set runs = r.runs + 1
    where r.runs < p_limit
  returning r.runs into v_runs;

  if v_runs is null then
    return jsonb_build_object('ok', false, 'day', v_day, 'remaining', 0);
  end if;
  return jsonb_build_object('ok', true, 'day', v_day, 'remaining', greatest(p_limit - v_runs, 0));
end;
$$;

-- Give back one run reserved on `p_day`. Never below zero; a release for a
-- row that does not exist does nothing.
create or replace function public.release_public_tool_user_run(
  p_user_id uuid,
  p_day date
)
returns void
language sql
security invoker
set search_path = public
as $$
  update public.public_tool_user_runs
     set runs = greatest(runs - 1, 0)
   where user_id = p_user_id
     and day = p_day;
$$;

revoke all on function public.reserve_public_tool_user_run(uuid, integer) from public, anon, authenticated;
revoke all on function public.release_public_tool_user_run(uuid, date) from public, anon, authenticated;
grant execute on function public.reserve_public_tool_user_run(uuid, integer) to service_role;
grant execute on function public.release_public_tool_user_run(uuid, date) to service_role;
