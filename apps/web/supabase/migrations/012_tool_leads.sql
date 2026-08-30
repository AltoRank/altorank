-- Tool leads captured from free SEO tools (email gate)
create table if not exists tool_leads (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  tool_slug text not null,
  context jsonb default '{}',
  converted_to_signup boolean default false,
  created_at timestamptz default now()
);

-- Index for dedup + analytics queries
create index idx_tool_leads_email on tool_leads (email);
create index idx_tool_leads_slug on tool_leads (tool_slug);
create index idx_tool_leads_created on tool_leads (created_at desc);

-- No RLS — this table is written by server actions only (service role or anon insert)
alter table tool_leads enable row level security;

-- Allow anon inserts (from server actions running without auth)
create policy "Allow anon insert" on tool_leads
  for insert to anon with check (true);
