-- 034: a history of what a site was, not only what it is
-- Depends on: 001_initial_schema (workspaces)
--
-- workspaces.dr and workspaces.traffic are single columns, overwritten by
-- every analysis, so the product could say "authority 34" and never "34, up
-- from 27 in June". Every number here is one we already fetch on each run;
-- recording it costs no extra provider call.
--
-- One row per workspace per day: re-running an analysis on the same day
-- corrects that day rather than adding a second point.

CREATE TABLE IF NOT EXISTS workspace_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  measured_on date NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  /** DataForSEO backlink rank mapped to 0-100. Not Ahrefs DR. */
  authority integer,
  /** Estimated monthly organic visits. */
  traffic integer,
  referring_domains integer,
  ranking_keywords integer,
  readiness integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, measured_on)
);

CREATE INDEX IF NOT EXISTS workspace_metrics_workspace_date
  ON workspace_metrics (workspace_id, measured_on DESC);

ALTER TABLE workspace_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members see their own workspaces' history" ON workspace_metrics
  FOR SELECT USING (
    workspace_id IN (
      SELECT w.id FROM workspaces w
      JOIN agency_members m ON m.agency_id = w.agency_id
      WHERE m.user_id = auth.uid()
    )
  );

COMMENT ON TABLE workspace_metrics IS 'Daily snapshot per workspace, written by the analysis from numbers it already fetched.';
