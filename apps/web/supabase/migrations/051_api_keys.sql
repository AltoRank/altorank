-- 051: Scoped API keys for the agent surface
-- Depends on: 001_initial_schema (agencies, user_agency_ids)
--
-- One account, many keys. Each key is named, can expire, and can be revoked
-- on its own, so a leaked key for one agent does not force every other
-- integration to rotate. Only a SHA-256 hash of the key is stored; the full
-- value is shown once at creation and cannot be recovered afterwards.
--
-- `agencies.api_key` (001) is the single plaintext key the General settings
-- panel still shows. It is DEPRECATED in favour of this table and will be
-- dropped once nothing reads it; the agent API never accepts it.

create table if not exists api_keys (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id) on delete cascade,
  name text not null,
  -- sha256 of the full key, hex. Never the key itself.
  key_hash text not null unique,
  -- First characters of the key (`altorank_live_` plus a few), so a human can
  -- tell keys apart in the list without the value being recoverable.
  prefix text not null,
  scopes text[] not null default '{}',
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now()
);

comment on column agencies.api_key is
  'DEPRECATED: single plaintext key kept for the legacy General settings panel. Use api_keys.';

create index if not exists api_keys_agency on api_keys (agency_id, created_at desc);

-- === RLS ===
alter table api_keys enable row level security;

-- Members of the agency can list and manage its keys. Owner/admin-only is
-- enforced in the server actions, matching how agency_members is handled.
-- The agent API itself authenticates with the service role and looks a key up
-- by hash, so no policy is needed for that path.
drop policy if exists "API keys by agency" on api_keys;
create policy "API keys by agency" on api_keys
  for all using (agency_id in (select user_agency_ids()))
  with check (agency_id in (select user_agency_ids()));
