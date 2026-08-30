-- 009: Domain auditing
-- Depends on: 001_initial_schema (workspaces table)

CREATE TABLE domain_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','completed','failed')),
  pages_crawled integer DEFAULT 0,
  overall_score integer DEFAULT 0,
  issues jsonb DEFAULT '[]',
  pagespeed jsonb DEFAULT '{}',
  competitor_data jsonb DEFAULT '{}',
  started_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX idx_domain_audits_workspace ON domain_audits(workspace_id, started_at DESC);
