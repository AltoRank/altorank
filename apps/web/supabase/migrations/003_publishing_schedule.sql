-- Publishing schedule: cadences, per-article overrides, audit log

-- === Publishing cadences (1:1 per workspace) ===
create table publishing_cadences (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references workspaces(id) on delete cascade,
  timezone text not null default 'Europe/Rome',
  days_of_week integer[] not null default '{}',
  publish_time time not null default '10:00',
  enabled boolean not null default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- === Per-article schedule override ===
alter table articles
  add column scheduled_at timestamptz;

-- === Publish log (audit trail) ===
create table publish_log (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references articles(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  status text not null check (status in ('success', 'error')),
  error text,
  triggered_by text not null check (triggered_by in ('cron', 'manual')),
  created_at timestamptz default now()
);

-- === Indexes ===
create index articles_scheduled on articles (status, scheduled_at)
  where status = 'scheduled';

create index publish_log_workspace on publish_log (workspace_id, created_at desc);

-- === RLS ===
alter table publishing_cadences enable row level security;
alter table publish_log enable row level security;

create policy "Cadences by agency" on publishing_cadences
  for all using (
    workspace_id in (select id from workspaces where agency_id in (select user_agency_ids()))
  );

create policy "Publish log by agency" on publish_log
  for all using (
    workspace_id in (select id from workspaces where agency_id in (select user_agency_ids()))
  );
