-- 104: a first look that planned nothing is its own outcome, not a failure
-- Depends on: 076_onboarding_runs. Independent of 097-103.
-- Apply BEFORE its code is deployed: see RUNBOOK.md. The new code selects
-- `empty_pool` on every read of a run and writes `nothing_planned`, so on a
-- database without this file /api/onboard/state fails and a finished run
-- cannot be closed. Old code never reads the column and never writes the new
-- status, so applying it early changes nothing.
--
-- On 2026-09-28 both real signups' first looks ended with zero qualified
-- topics: the site was read, keywords were found, every candidate was judged,
-- none cleared the bar. The row said `partial`, which the run store read as
-- "fell short", so the person got a "Setup didn't finish" email and a screen
-- asking for a card over an empty calendar. Nothing was broken. So the row
-- gets a status of its own for it, and the reason:
--
-- `nothing_planned`   the pipeline ran every phase without failing and
--                     nothing cleared the bar: no plan, no draft. Not an
--                     error, not `partial` (which still means a phase fell
--                     short or produced only half).
-- `empty_pool`        which stage emptied the pool, from what the pipeline
--                     already had: the keyword count and the verdicts on the
--                     site's keyword rows, tallied by cause. Written by the
--                     worker with the planning phase; null on every other run.
alter table onboarding_runs drop constraint if exists onboarding_runs_status_check;
alter table onboarding_runs add constraint onboarding_runs_status_check
  check (status in ('running', 'done', 'partial', 'nothing_planned', 'error'));

alter table onboarding_runs add column if not exists empty_pool jsonb;

comment on column onboarding_runs.empty_pool is
  'Why a first look planned nothing: {stage, cause, keywords, qualified, rejected, pending, summary}. Null unless the planning phase found nothing to plan.';
