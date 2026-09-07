-- 075: the monthly report upsert needs the key it upserts on
-- Depends on: 001_initial_schema (reports)
--
-- lib/reports/generate.ts writes a report with
--   .upsert({...}, { onConflict: "workspace_id,period" })
-- but no migration ever created a unique constraint on (workspace_id, period):
-- 001 gives `reports` only its primary key and the workspace foreign key.
-- PostgREST then rejects the upsert with "there is no unique or exclusion
-- constraint matching the ON CONFLICT specification", so cron/reports has
-- never written a report row (found 2026-09-07 booting the integration
-- branch: 26 errors out of 26 workspaces).
--
-- Duplicates cannot exist for the same reason (nothing could insert), but the
-- index is guarded anyway. If it fails, this finds the rows:
--   select workspace_id, period, count(*) from reports group by 1,2 having count(*) > 1;
create unique index if not exists idx_reports_one_per_period
  on reports (workspace_id, period);
