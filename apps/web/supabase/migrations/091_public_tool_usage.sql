-- Daily run and spend counter for the public, unauthenticated tools
-- (POST /api/public/tools/<slug>, lib/public-tools/spend.ts).
--
-- One row per UTC day per tool. Paid tools reserve their estimated cost here
-- before they run; the reservation is refused once the day's total across
-- ALL tools would pass the cap the caller passes in. Fetch-only tools never
-- touch this table.
--
-- Service role only: RLS on with no policies, and no grants to anon or
-- authenticated. Nothing user-facing reads it.

create table if not exists public.public_tool_usage (
  day date not null,
  tool text not null check (char_length(tool) between 1 and 100),
  runs integer not null default 0,
  cost_cents numeric not null default 0,
  primary key (day, tool)
);

alter table public.public_tool_usage enable row level security;
revoke all on public.public_tool_usage from anon, authenticated;
grant all on public.public_tool_usage to service_role;

-- Atomic check-and-reserve. The advisory lock serialises concurrent
-- reservations, so two runs cannot both read "under the cap" and both write.
-- Transaction-scoped: released when the RPC's transaction ends.
create or replace function public.reserve_public_tool_spend(
  p_tool text,
  p_estimate_cents numeric,
  p_cap_cents numeric
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_spent numeric;
begin
  if p_tool is null or char_length(p_tool) not between 1 and 100 then
    raise exception 'reserve_public_tool_spend: invalid tool';
  end if;
  if p_estimate_cents is null or p_estimate_cents < 0 or p_cap_cents is null or p_cap_cents < 0 then
    raise exception 'reserve_public_tool_spend: invalid amount';
  end if;

  perform pg_advisory_xact_lock(hashtext('public_tool_usage'));

  select coalesce(sum(cost_cents), 0) into v_spent
  from public.public_tool_usage
  where day = v_day;

  if v_spent + p_estimate_cents > p_cap_cents then
    return false;
  end if;

  insert into public.public_tool_usage (day, tool, runs, cost_cents)
  values (v_day, p_tool, 1, p_estimate_cents)
  on conflict (day, tool) do update
    set runs = public.public_tool_usage.runs + 1,
        cost_cents = public.public_tool_usage.cost_cents + excluded.cost_cents;

  return true;
end;
$$;

revoke all on function public.reserve_public_tool_spend(text, numeric, numeric) from public, anon, authenticated;
grant execute on function public.reserve_public_tool_spend(text, numeric, numeric) to service_role;
