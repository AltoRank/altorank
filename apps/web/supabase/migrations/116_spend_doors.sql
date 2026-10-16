-- 116: how often a person may press a paid door, what the Operations page sums,
-- and the customer's own last sign-in kept across "View as"
-- Depends on: 025_provider_spend (and 106's `stage` column), 030_admin_impersonations,
-- 085_agencies_to_accounts (accounts, workspaces.account_id).
-- Apply AFTER its code is live: see RUNBOOK.md. The code that ships with it
-- calls every object below when it is there and keeps working when it is not
-- (lib/billing/spend-doors.ts counts in memory, lib/admin/spend-summary.ts
-- pages through provider_spend, app/actions/impersonation.ts writes the log
-- row without the new column). Code from before it never names them.
--
-- 1. spend_door_uses + take_spend_door(). A few paid doors are pressed by a
--    person and had nothing between one press and the next: the editor's
--    whole-article rewrite (a long Sonnet call) and its quick rewrites, and
--    the setup wizard's site read, rival lookup and typed-rival lookup, which
--    a reload of the wizard bought again. Each press is now counted here, per
--    account and per site, in the windows the app names; the function counts
--    and inserts under one advisory lock per account and door, so two presses
--    at once cannot both slip under a limit. The wizard's reads also keep
--    what they bought (`cache_key`, `result`) so a reload hands it back.
--    Server-written only: RLS on, no policies, no grants to client roles, and
--    the function executable by the service role alone. A row outlives its
--    site (`on delete set null`), so deleting a site and adding it again does
--    not hand its count back.
--
-- 2. provider_spend.job and provider_spend_summary(). The Operations page
--    read the newest 2,000 provider_spend rows, and PostgREST answers at most
--    1,000, so every total on it covered the newest thousand calls. This sums
--    the whole table in the database, grouped the way the page reports it.
--    Service role only. `job` says which work bought a row (a cron's name,
--    `onboarding`, `editor`), so the schedule's "Actual" files each row under
--    the job that spent it instead of guessing from the provider: every model
--    call landed under the nightly writer, refresh and setup included.
--
-- 3. admin_impersonations.target_last_sign_in_at. "View as" signs in as the
--    customer, which stamps their last sign-in. The customer's own value is
--    kept on the log row so the Users page can show it instead.
--
-- Idempotent: every statement is guarded or replaces what it names.
-- Rollback in RUNBOOK.md.

-- 1 ---------------------------------------------------------------------------

create table if not exists public.spend_door_uses (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  workspace_id uuid references public.workspaces(id) on delete set null,
  door text not null,
  used_at timestamptz not null default now(),
  -- What the press bought, for a wizard read handed back on reload. Null for
  -- every door that keeps nothing, and for a press that bought nothing.
  cache_key text,
  result jsonb
);

create index if not exists idx_spend_door_uses_account
  on public.spend_door_uses (account_id, door, used_at desc);
create index if not exists idx_spend_door_uses_workspace
  on public.spend_door_uses (workspace_id, door, used_at desc);

comment on table public.spend_door_uses is
  'One row per press of a paid door (editor rewrites, the setup wizard''s reads), counted by take_spend_door. Server-written only (migration 116).';
comment on column public.spend_door_uses.result is
  'What a wizard read bought, handed back to a reload instead of buying it again. Null when nothing is kept.';

alter table public.spend_door_uses enable row level security;
revoke all on table public.spend_door_uses from anon, authenticated;
grant select, insert, update, delete on table public.spend_door_uses to service_role;

-- Both functions below first check the role a PostgREST request runs as, from
-- its JWT: only the service role passes. A direct database session (psql, a
-- migration) carries no claims and is the operator, so it passes too. The
-- revokes say the same; the check holds even if a later grant forgets.
--
-- p_limits: [{"scope": "account" | "workspace", "limit": n, "seconds": n | null}].
-- `seconds` null counts every use there has ever been. A workspace limit with
-- no workspace is skipped. Returns the new row's id, or null and the index of
-- the first limit that refused (nothing is written then).
-- caller: service-role
create or replace function public.take_spend_door(
  p_account uuid,
  p_workspace uuid,
  p_door text,
  p_limits jsonb
) returns table (use_id uuid, refused_index integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  l jsonb;
  i integer := 0;
  used integer;
  since timestamptz;
  new_id uuid;
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', 'service_role') <> 'service_role' then
    raise exception 'take_spend_door: service role only' using errcode = '42501';
  end if;
  if p_account is null or p_door is null then
    raise exception 'take_spend_door: account and door are required' using errcode = '22004';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('spend_door:' || p_account::text || ':' || p_door, 0));
  for l in select value from jsonb_array_elements(coalesce(p_limits, '[]'::jsonb)) loop
    since := case when l->>'seconds' is null then '-infinity'::timestamptz
                  else now() - make_interval(secs => (l->>'seconds')::double precision) end;
    if l->>'scope' = 'workspace' then
      if p_workspace is not null then
        select count(*) into used from public.spend_door_uses u
         where u.workspace_id = p_workspace and u.door = p_door and u.used_at > since;
        if used >= (l->>'limit')::integer then
          return query select null::uuid, i;
          return;
        end if;
      end if;
    else
      select count(*) into used from public.spend_door_uses u
       where u.account_id = p_account and u.door = p_door and u.used_at > since;
      if used >= (l->>'limit')::integer then
        return query select null::uuid, i;
        return;
      end if;
    end if;
    i := i + 1;
  end loop;
  insert into public.spend_door_uses (account_id, workspace_id, door)
  values (p_account, p_workspace, p_door)
  returning id into new_id;
  return query select new_id, null::integer;
end $$;

revoke execute on function public.take_spend_door(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.take_spend_door(uuid, uuid, text, jsonb) to service_role;

-- 2 ---------------------------------------------------------------------------

alter table public.provider_spend add column if not exists job text;
comment on column public.provider_spend.job is
  'Which work bought the row: the cron''s name (cron.generate, cron.refresh, ...), onboarding, or editor. Null for rows from before migration 116 and for work no job names.';

-- Every provider_spend row, summed in groups the Operations page reports by.
-- `recent` splits each group at p_since (the page's 30-day window).
-- `model_articles` is the number of distinct articles anthropic rows with a
-- price were bought for: the denominator of the model cost per article. The
-- editor's rewrites and the scheduled refresh are left out: they are bought
-- for an article already written (lib/billing/forecast.ts, writesArticle).
-- caller: service-role
create or replace function public.provider_spend_summary(p_since timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  out jsonb;
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', 'service_role') <> 'service_role' then
    raise exception 'provider_spend_summary: service role only' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'calls', (select count(*) from public.provider_spend),
    'first_at', (select min(created_at) from public.provider_spend),
    'model_articles', (select count(distinct article_id) from public.provider_spend
                        where provider = 'anthropic' and article_id is not null and cost_usd is not null
                          and operation not like 'editor/%'
                          and coalesce(job, '') not in ('editor', 'cron.refresh')),
    'groups', coalesce((
      select jsonb_agg(g) from (
        select provider,
               operation,
               workspace_id,
               stage,
               job,
               article_id is not null as has_article,
               created_at >= p_since as recent,
               count(*) as calls,
               count(cost_usd) as priced,
               coalesce(sum(cost_usd), 0) as usd
          from public.provider_spend
         group by 1, 2, 3, 4, 5, 6, 7
      ) g
    ), '[]'::jsonb)
  ) into out;
  return out;
end $$;

revoke execute on function public.provider_spend_summary(timestamptz) from public, anon, authenticated;
grant execute on function public.provider_spend_summary(timestamptz) to service_role;

-- 3 ---------------------------------------------------------------------------

alter table public.admin_impersonations add column if not exists target_last_sign_in_at timestamptz;
comment on column public.admin_impersonations.target_last_sign_in_at is
  'The customer''s own last sign-in, read before "View as" signed in as them (which stamps a new one). Null when they had never signed in, or for rows from before migration 116.';
