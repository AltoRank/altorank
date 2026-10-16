-- 115: a Search Console connection records what its syncs answered
-- Depends on: 001 (workspace_integrations), 070 (last_sync_error).
-- Apply AFTER its code is live: see RUNBOOK.md. The code reads and writes
-- these columns only when they exist, so it runs the same before and after.
--
-- The only trace a sync left was the rows it stored. A day Google answered
-- with no impressions stores none, so a site with no search impressions
-- looked exactly like a connection that had never synced, forever. And the
-- earliest stored row was the only sign of how far back history goes, so a
-- site that had a single row in the window before its connection was
-- compared month against month as if both months were whole.
--
-- Three columns on the connection row (the gsc row of a site):
--
--   last_synced_at  when a sync of this site's Search Console last completed
--   synced_from     the first day of the unbroken run of days Google has
--                   answered for, rows or not
--   synced_through  the last day of that run
--
-- A day counts once Google answered it with rows, or answered it empty after
-- its publishing lag (lib/google/sync.ts SYNC_LAG_DAYS), when an empty answer
-- is a zero and not a day Google has not written yet. The run restarts after
-- days that were never synced (lib/google/sync.ts nextSyncedRange), so every
-- day inside it was answered. The first run starts from the rows already
-- stored, so history from before this migration still counts.
--
-- Idempotent: `add column if not exists`. Rollback in RUNBOOK.md.

alter table public.workspace_integrations
  add column if not exists last_synced_at timestamptz;

alter table public.workspace_integrations
  add column if not exists synced_from date;

alter table public.workspace_integrations
  add column if not exists synced_through date;

comment on column public.workspace_integrations.last_synced_at is
  'When a sync of this connection last completed. Set by the server (lib/google/sync.ts).';
comment on column public.workspace_integrations.synced_from is
  'Search Console: the first day of the unbroken run of days the sync has an answer for, including days Google reported as empty.';
comment on column public.workspace_integrations.synced_through is
  'Search Console: the last day of that run.';
