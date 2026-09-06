-- A Google connection whose refresh token has died says so.
--
-- When Google answers a token refresh with invalid_grant (the person revoked
-- access, changed their password, or the token aged out) or a 401, the
-- nightly sync in lib/google/sync.ts caught the error, put it in the cron's
-- JSON result and moved on. Nothing was written to the row, so the settings
-- tab kept saying "Connected", the dashboard blocks went quietly stale, and
-- the cron asked Google the same dead question every night.
--
-- Two columns on the connection row, because the connection is what needs
-- the person's attention, not the metrics:
--
--   needs_reconnect  set by the sync when the token is dead; read by the
--                    cron (skips the row), the settings tab, the dashboard
--                    gate and the agent's sync block; cleared by the OAuth
--                    callback when the row is written again with fresh tokens
--   last_sync_error  the message that set it, for the person and the log
alter table workspace_integrations
  add column if not exists needs_reconnect boolean not null default false;

alter table workspace_integrations
  add column if not exists last_sync_error text;

comment on column workspace_integrations.needs_reconnect is
  'True when the stored token was refused by the provider (invalid_grant / 401). Cleared when the connection is re-authorised.';
comment on column workspace_integrations.last_sync_error is
  'The provider error that last failed a sync for this connection, or null.';
