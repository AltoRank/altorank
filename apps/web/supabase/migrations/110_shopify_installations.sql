-- 110: Shopify App Store installations
-- Depends on: 085_agencies_to_accounts (accounts), 001_initial_schema (workspaces).
-- Apply BEFORE its code is deployed: nothing reads these tables until a store
-- installs the app, and the webhook route writes them from its first call.
--
-- A merchant who installs AltoRank from the Shopify App Store never pastes a
-- credential. The embedded app exchanges App Bridge's ID token for an
-- expiring offline access token (1 hour) and a refresh token (90 days,
-- rotated on every refresh), and those live here rather than in
-- workspace_integrations.config, because they change every hour and config
-- is written once at connect time. The integration row points here by
-- installation id (`config.installationId`); see lib/shopify/installations.ts.
-- https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens
--
-- Both tables are read and written on the service role only: the embedded
-- app has no Supabase session (it runs in Shopify's iframe) and webhooks have
-- no user at all. RLS on with no policies, so anon and authenticated cannot
-- touch them, the same as 080.

create table if not exists shopify_installations (
  id uuid primary key default gen_random_uuid(),
  -- The permanent *.myshopify.com host. One row per store, kept across an
  -- uninstall so a reinstall finds its account again.
  shop_domain text not null unique,
  -- Null until the store is linked to an account and site (the embedded
  -- app's first open does that).
  account_id uuid references accounts(id) on delete set null,
  workspace_id uuid references workspaces(id) on delete set null,
  -- AES-256-GCM via lib/crypto.ts encrypt(), never plaintext.
  access_token text,
  access_expires_at timestamptz,
  refresh_token text,
  refresh_expires_at timestamptz,
  scopes text,
  -- A refresh in flight holds this lease, so two publishers never refresh one
  -- store at once (Shopify retires whichever pair is used second).
  refreshing_until timestamptz,
  -- Set when Shopify refused the refresh token for good: the merchant has to
  -- open the app in their admin once so a fresh ID token can be exchanged.
  needs_reauth_at timestamptz,
  shop_name text,
  primary_domain text,
  installed_at timestamptz not null default now(),
  uninstalled_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists shopify_installations_account on shopify_installations (account_id);
create index if not exists shopify_installations_workspace on shopify_installations (workspace_id);

-- Shopify may deliver a webhook more than once. A delivery is claimed here by
-- its X-Shopify-Webhook-Id before it is acted on.
create table if not exists shopify_webhook_events (
  webhook_id text primary key,
  topic text not null,
  shop_domain text not null,
  received_at timestamptz not null default now()
);

create index if not exists shopify_webhook_events_received on shopify_webhook_events (received_at);

alter table shopify_installations enable row level security;
alter table shopify_webhook_events enable row level security;
