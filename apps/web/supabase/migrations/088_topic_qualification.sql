-- Durable evidence shared by onboarding, research and automatic writing.
alter table public.keywords
  add column if not exists source_url text,
  add column if not exists buyer_fit jsonb,
  add column if not exists opportunity jsonb;

comment on column public.keywords.opportunity is
  'Versioned buyer and live SERP qualification. Missing/stale evidence is pending, never permission to write automatically.';
