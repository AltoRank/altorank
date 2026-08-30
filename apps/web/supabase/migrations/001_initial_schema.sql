-- AltoRank initial schema
-- Run with: supabase db push

-- === Agencies ===
create table agencies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  logo_url text,
  report_email text,
  custom_domain text,
  accent_color text,
  remove_branding boolean default false,
  api_key text,
  plan text not null default 'starter' check (plan in ('starter', 'growth', 'scale')),
  stripe_customer_id text,
  stripe_subscription_id text,
  created_at timestamptz default now()
);

-- === Agency Members ===
create table agency_members (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'editor' check (role in ('owner', 'admin', 'editor')),
  created_at timestamptz default now(),
  unique (agency_id, user_id)
);

-- === Workspaces (Clients) ===
create table workspaces (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id) on delete cascade,
  name text not null,
  domain text,
  initials text not null default '',
  color text not null default 'av-c1',
  plan text,
  status text not null default 'setup' check (status in ('on', 'review', 'paused', 'setup')),
  dr integer default 0,
  traffic text default '0',
  created_at timestamptz default now()
);

-- === Articles ===
create table articles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  title text not null,
  slug text not null,
  content jsonb,
  keyword text,
  status text not null default 'draft' check (status in ('draft', 'drafting', 'review', 'scheduled', 'live', 'error')),
  seo_score integer default 0,
  volume integer default 0,
  position integer,
  word_count integer default 0,
  cms text,
  published_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- === Keywords ===
create table keywords (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  term text not null,
  volume integer default 0,
  difficulty integer default 0,
  intent text default 'info' check (intent in ('info', 'commercial', 'transactional', 'navigational')),
  status text default 'new' check (status in ('new', 'planned', 'drafting', 'scheduled', 'shipped', 'error')),
  created_at timestamptz default now()
);

-- === Backlinks ===
create table backlinks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  source_domain text not null,
  source_dr integer default 0,
  anchor_text text,
  target_url text,
  status text default 'pending' check (status in ('live', 'pending', 'negotiating', 'lost')),
  discovered_at timestamptz default now()
);

-- === Calendar Entries ===
create table calendar_entries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  article_id uuid references articles(id) on delete set null,
  keyword text,
  scheduled_date date not null,
  status text default 'queue' check (status in ('done', 'run', 'scheduled', 'queue')),
  created_at timestamptz default now()
);

-- === Integrations (reference table) ===
create table integrations (
  id text primary key,
  name text not null,
  tag text not null check (tag in ('CMS', 'Analytics', 'Data', 'Notify', 'Automate')),
  description text,
  icon_key text
);

-- === Workspace Integrations ===
create table workspace_integrations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  integration_id text not null references integrations(id) on delete cascade,
  config jsonb default '{}',
  connected_at timestamptz default now(),
  unique (workspace_id, integration_id)
);

-- === Voice Profiles ===
create table voice_profiles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade unique,
  sample_text text,
  rules jsonb default '{}',
  trained boolean default false,
  created_at timestamptz default now()
);

-- === Reports ===
create table reports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  period text not null,
  articles_count integer default 0,
  traffic text default '0',
  keywords_count integer default 0,
  status text default 'draft',
  url text,
  created_at timestamptz default now()
);

-- === Invoices ===
create table invoices (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id) on delete cascade,
  number text not null,
  period text not null,
  articles integer default 0,
  amount numeric(10,2) default 0,
  status text default 'pending',
  pdf_url text,
  created_at timestamptz default now()
);

-- ============================================================
-- RLS Policies
-- ============================================================

alter table agencies enable row level security;
alter table agency_members enable row level security;
alter table workspaces enable row level security;
alter table articles enable row level security;
alter table keywords enable row level security;
alter table backlinks enable row level security;
alter table calendar_entries enable row level security;
alter table integrations enable row level security;
alter table workspace_integrations enable row level security;
alter table voice_profiles enable row level security;
alter table reports enable row level security;
alter table invoices enable row level security;

-- Helper: get agency IDs the current user belongs to
create or replace function user_agency_ids()
returns setof uuid
language sql
security definer
stable
as $$
  select agency_id from agency_members where user_id = auth.uid();
$$;

-- Agencies: see only your own
create policy "Users see own agencies" on agencies
  for select using (id in (select user_agency_ids()));
create policy "Users update own agencies" on agencies
  for update using (id in (select user_agency_ids()));

-- Agency members: see members of your agency
create policy "Members see own agency members" on agency_members
  for select using (agency_id in (select user_agency_ids()));
create policy "Owners manage members" on agency_members
  for all using (
    agency_id in (
      select agency_id from agency_members
      where user_id = auth.uid() and role in ('owner', 'admin')
    )
  );

-- Workspaces: scoped to agency
create policy "Workspaces by agency" on workspaces
  for all using (agency_id in (select user_agency_ids()));

-- Articles: scoped via workspace → agency
create policy "Articles by agency" on articles
  for all using (
    workspace_id in (select id from workspaces where agency_id in (select user_agency_ids()))
  );

-- Keywords: scoped via workspace → agency
create policy "Keywords by agency" on keywords
  for all using (
    workspace_id in (select id from workspaces where agency_id in (select user_agency_ids()))
  );

-- Backlinks: scoped via workspace → agency
create policy "Backlinks by agency" on backlinks
  for all using (
    workspace_id in (select id from workspaces where agency_id in (select user_agency_ids()))
  );

-- Calendar: scoped via workspace → agency
create policy "Calendar by agency" on calendar_entries
  for all using (
    workspace_id in (select id from workspaces where agency_id in (select user_agency_ids()))
  );

-- Integrations: public read (reference data)
create policy "Integrations are public" on integrations
  for select using (true);

-- Workspace integrations: scoped via workspace → agency
create policy "WS integrations by agency" on workspace_integrations
  for all using (
    workspace_id in (select id from workspaces where agency_id in (select user_agency_ids()))
  );

-- Voice: scoped via workspace → agency
create policy "Voice by agency" on voice_profiles
  for all using (
    workspace_id in (select id from workspaces where agency_id in (select user_agency_ids()))
  );

-- Reports: scoped via workspace → agency
create policy "Reports by agency" on reports
  for all using (
    workspace_id in (select id from workspaces where agency_id in (select user_agency_ids()))
  );

-- Invoices: scoped to agency
create policy "Invoices by agency" on invoices
  for all using (agency_id in (select user_agency_ids()));
