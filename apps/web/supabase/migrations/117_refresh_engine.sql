-- 117: refresh engine bookkeeping - when a rewrite started, and which
-- candidates a pass retired
-- Depends on: 052_refresh_engine (refresh_tasks, refresh_candidates).
-- Apply AFTER its code is live: see RUNBOOK.md.
--
-- `refresh_tasks.started_at`: when cron/refresh claimed the task and set it
-- `running`. A rewrite runs inside one cron invocation (300 s), so a task
-- still running fifteen minutes after it started was cut off before it could
-- record an outcome. The cron marks those failed at the start of each run,
-- and cancel, reschedule and dismiss treat them as open
-- (lib/refresh/tasks.ts). Without this column the code uses the task's
-- `created_at` instead, which is coarser but never later than the start.
--
-- Written by the server only in practice; the existing "Refresh tasks by
-- access" policy (062) covers the column like the rest of the row, and a
-- member who sets it can only make their own task look stopped sooner, which
-- they can already do by cancelling it.
--
-- `refresh_candidates.resolved_at`: set, together with `dismissed_at`, when
-- an analysis pass retires an open candidate because its numbers no longer
-- fire (lib/refresh/detect.ts). `dismissed_at` alone is a person's "not now";
-- both is the pass's "recovered". Closing through `dismissed_at` keeps 052's
-- one-open-candidate index meaning what it says, and lets a later pass raise
-- the page again. Without this column the pass closes with `dismissed_at`
-- only.
--
-- Idempotent: `add column if not exists`. Rollback in RUNBOOK.md.

alter table public.refresh_tasks
  add column if not exists started_at timestamptz;

comment on column public.refresh_tasks.started_at is
  'When cron/refresh set this task running. A running task older than 15 minutes was cut off and is marked failed by the next run (lib/refresh/tasks.ts).';

alter table public.refresh_candidates
  add column if not exists resolved_at timestamptz;

comment on column public.refresh_candidates.resolved_at is
  'When an analysis pass retired this candidate because its numbers no longer fire. Set with dismissed_at; dismissed_at alone means a person dismissed it.';
