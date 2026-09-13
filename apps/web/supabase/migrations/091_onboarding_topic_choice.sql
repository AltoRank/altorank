-- A persisted, resumable choice between research and the first paid generation.
ALTER TABLE public.onboarding_runs DROP CONSTRAINT IF EXISTS onboarding_runs_status_check;
ALTER TABLE public.onboarding_runs ADD CONSTRAINT onboarding_runs_status_check
  CHECK (status IN ('running', 'awaiting_choice', 'done', 'partial', 'error'));
DROP INDEX IF EXISTS public.idx_onboarding_runs_one_running_per_workspace;
CREATE UNIQUE INDEX idx_onboarding_runs_one_running_per_workspace
  ON public.onboarding_runs(workspace_id) WHERE status IN ('running', 'awaiting_choice');
