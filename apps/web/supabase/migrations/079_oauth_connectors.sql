-- 079: OAuth 2.0 for the hosted MCP endpoint
-- Depends on: 051_api_keys (api_keys), 001_initial_schema (agencies)
--
-- MCP clients (ChatGPT, Claude.ai, Cursor, Codex...) add
-- https://app.altorank.co/api/mcp as a connector and expect to sign in with
-- OAuth rather than paste an API key: dynamic client registration (RFC 7591),
-- authorization code with PKCE (RFC 7636), discovery (RFC 8414 / 9728).
--
-- The access token an approved connector ends up with IS an api_keys row
-- (`altorank_live_…`, hashed, scoped, expiring). That keeps one credential
-- model: the agent API authenticates it like any other key, the human sees it
-- in /settings/api-keys next to the keys they made by hand, and revoking it
-- there is how a connector is disconnected. Nothing here is a second way in.
--
-- Both tables are read and written on the service role only (the token and
-- registration endpoints have no user session). RLS is on with no policies,
-- so the anon and authenticated roles cannot touch them at all.

create table if not exists oauth_clients (
  -- The client_id handed out at registration. Opaque, unguessable.
  id text primary key,
  client_name text not null,
  redirect_uris text[] not null,
  created_at timestamptz not null default now()
);

create table if not exists oauth_codes (
  -- sha256 of the code, hex. Never the code itself.
  code_hash text primary key,
  client_id text not null references oauth_clients(id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  scopes text[] not null,
  agency_id uuid not null references agencies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists oauth_codes_expiry on oauth_codes (expires_at);

-- Which connector minted a key, so the keys page can say "ChatGPT" and the
-- token endpoint can refuse a second exchange of the same code.
alter table api_keys add column if not exists oauth_client_id text references oauth_clients(id) on delete set null;

alter table oauth_clients enable row level security;
alter table oauth_codes enable row level security;
