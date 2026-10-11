-- 107: a first look says where its time went
-- Depends on: 076_onboarding_runs. Independent of 097-106.
-- Safe in either order with its code: the code writes `timings` in an update
-- of its own and ignores a failure, and never selects it on the polling path
-- (RUN_COLUMNS), so on a database without this file the run is unchanged and
-- only the timing table is missing. Old code never reads the column.
--
-- A production first look (2026-10-09) took 7m15s from run start to done and
-- the only record of where the time went was provider_spend's timestamps:
-- nothing was billed for the first 96 seconds, so the site read, the crawl,
-- the speed test and the voice were one undivided silence.
--
-- `timings`   every stage of the run, in milliseconds since `started_at`:
--             {origin, stages: {<stage>: {startMs, endMs, busyMs, calls}},
--             marks: {gate, body_done, run_done}, entries: [...]}. Written by
--             the worker when its phases are done and merged by the draft
--             route when the body lands (apps/web/lib/onboarding/timings.ts).
--             Counts and milliseconds only: no term, no text.
alter table onboarding_runs add column if not exists timings jsonb;

comment on column onboarding_runs.timings is
  'Per-stage timing of a first look, ms since started_at: {origin, stages, marks, entries}. Instrumentation only; null on runs before 107.';
