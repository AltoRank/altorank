-- 018: Automatic first-look analysis for a newly added domain
-- Depends on: 009_domain_audits (domain_audits), 001_initial_schema (workspaces)
--
-- Adding a client used to produce an empty workspace. Every analysis the
-- product can run needs nothing from the client (no CMS key, no OAuth, no DNS
-- change) yet none of it ran until somebody clicked a button, so the first
-- session showed zeroes and the value was invisible exactly when it mattered
-- most.
--
-- This lets a domain be analysed the moment it is added, so the dashboard has
-- real findings before the client has connected anything.

-- Agent-readiness result lives alongside the crawl rather than in `issues`,
-- which is the crawler's own shape and would lose the per-check detail.
ALTER TABLE domain_audits ADD COLUMN readiness jsonb;

-- Distinguishes the automatic first look from an audit somebody asked for.
ALTER TABLE domain_audits ADD COLUMN trigger text NOT NULL DEFAULT 'manual'
  CHECK (trigger IN ('manual', 'auto_onboarding', 'scheduled'));

-- Set when the first automatic analysis finishes, so the cron can find
-- workspaces it has never looked at without scanning every audit row. Nullable
-- rather than defaulted: NULL means "never analysed", which is the thing the
-- cron actually queries for.
ALTER TABLE workspaces ADD COLUMN first_analysed_at timestamptz;

COMMENT ON COLUMN domain_audits.readiness IS
  'AgentReadinessResult (lib/audit/agent-readiness.ts): the nine checks and their findings.';
COMMENT ON COLUMN workspaces.first_analysed_at IS
  'When the automatic first-look analysis completed. NULL means it has not run.';

-- The cron queries exactly this: workspaces with a domain that were never
-- analysed.
CREATE INDEX idx_workspaces_awaiting_analysis
  ON workspaces(created_at)
  WHERE first_analysed_at IS NULL AND domain IS NOT NULL;
