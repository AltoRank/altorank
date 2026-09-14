-- Prepare the first thirty days independently of publication dates. A leased
-- run serializes each workspace; each invocation writes at most one article.
create table first_month_runs (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  starts_on date not null default (now() at time zone 'UTC')::date,
  status text not null default 'queued' check (status in ('queued','planning','writing','ready','attention','blocked')),
  planned boolean not null default false,
  lease uuid,
  lease_until timestamptz,
  planning_attempts integer not null default 0,
  message text,
  created_at timestamptz not null default now()
);
create table first_month_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references first_month_runs(workspace_id) on delete cascade,
  entry_id uuid not null references calendar_entries(id) on delete cascade,
  scheduled_date date not null,
  status text not null default 'queued' check (status in ('queued','writing','ready','failed')),
  attempts integer not null default 0,
  article_id uuid references articles(id) on delete set null,
  unique(workspace_id, entry_id)
);
alter table first_month_runs enable row level security;
alter table first_month_jobs enable row level security;
create policy "Read first month for workspace" on first_month_runs for select
  using (workspace_id in (select user_workspace_ids()));
create policy "Read first month jobs for workspace" on first_month_jobs for select
  using (workspace_id in (select user_workspace_ids()));

-- Only service workers can claim. Concurrent webhook deliveries, browser
-- wakeups and cron rescues all lose cleanly to an unexpired lease.
create function claim_first_month(p_workspace uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare token uuid := gen_random_uuid();
begin
  update first_month_runs set lease = token, lease_until = now() + interval '10 minutes'
  where workspace_id = p_workspace and status in ('queued','planning','writing')
    and (lease_until is null or lease_until < now());
  if not found then return null; end if;
  return token;
end $$;
revoke all on function claim_first_month(uuid) from public, anon, authenticated;
grant execute on function claim_first_month(uuid) to service_role;

create function retry_first_month(p_workspace uuid) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform 1 from first_month_runs where workspace_id = p_workspace
    and status in ('attention','blocked')
    and (lease is null or lease_until < now()) for update;
  if not found then return false; end if;
  update first_month_jobs set status = 'queued', attempts = 0
    where workspace_id = p_workspace and status = 'failed';
  update first_month_runs set status = 'queued', planning_attempts = 0, message = null,
    lease = null, lease_until = null
    where workspace_id = p_workspace;
  return true;
end $$;
revoke all on function retry_first_month(uuid) from public, anon, authenticated;
grant execute on function retry_first_month(uuid) to service_role;
