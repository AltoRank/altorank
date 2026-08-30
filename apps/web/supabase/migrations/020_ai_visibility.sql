-- 020: AI visibility, the outcome half of GEO
-- Depends on: 001_initial_schema (workspaces)
--
-- Agent readiness measures whether a site can be read by an AI. This measures
-- whether the AI actually names it. The first is an input, the second is the
-- result the client is paying for, and until now only the input was measured.
--
-- Runs through DataForSEO's AI Optimization endpoints, which the existing
-- account already covers, across ChatGPT, Claude, Gemini and Perplexity.

-- The questions a buyer would actually type. Kept per workspace because the
-- prompt set IS the measurement: changing it changes the number, so it has to
-- be stable and inspectable rather than generated fresh each run.
CREATE TABLE geo_prompts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  prompt text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  UNIQUE (workspace_id, prompt)
);

-- One row per prompt per engine per run. Raw citations are kept, not just the
-- rates, so a claim about share of voice can always be traced back to the
-- answer it came from.
CREATE TABLE geo_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  prompt_id uuid REFERENCES geo_prompts(id) ON DELETE SET NULL,
  prompt text NOT NULL,
  engine text NOT NULL CHECK (engine IN ('chat_gpt', 'claude', 'gemini', 'perplexity')),
  model text NOT NULL,
  mentioned boolean NOT NULL,
  cited boolean NOT NULL,
  citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  competitor_domains jsonb NOT NULL DEFAULT '[]'::jsonb,
  fan_out_queries jsonb NOT NULL DEFAULT '[]'::jsonb,
  cost_usd numeric(10,5) NOT NULL DEFAULT 0,
  -- Set when the probe failed. Failed probes are stored but excluded from
  -- rates: missing data must not be reported as a bad result.
  error text,
  checked_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_geo_results_workspace ON geo_results(workspace_id, checked_at DESC);
CREATE INDEX idx_geo_prompts_workspace ON geo_prompts(workspace_id) WHERE enabled;

-- Opt-in, like autonomous generation and for a sharper reason: a web-search
-- answer costs roughly 60x a plain completion, so a full sweep is the most
-- expensive scheduled thing the product can do.
ALTER TABLE workspaces ADD COLUMN geo_tracking boolean NOT NULL DEFAULT false;
ALTER TABLE workspaces ADD COLUMN geo_last_checked_at timestamptz;

COMMENT ON TABLE geo_prompts IS
  'The buyer questions a workspace is measured against. The prompt set is the measurement, so it is stable and human-owned.';
COMMENT ON COLUMN geo_results.error IS
  'Probe failure. Stored for visibility, excluded from mention and citation rates.';

ALTER TABLE geo_prompts ENABLE ROW LEVEL SECURITY;
ALTER TABLE geo_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members see own geo prompts" ON geo_prompts
  FOR ALL USING (
    workspace_id IN (
      SELECT id FROM workspaces WHERE agency_id IN (SELECT user_agency_ids())
    )
  );

CREATE POLICY "Members see own geo results" ON geo_results
  FOR ALL USING (
    workspace_id IN (
      SELECT id FROM workspaces WHERE agency_id IN (SELECT user_agency_ids())
    )
  );
