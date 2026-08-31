-- 025: what each run actually cost
-- Depends on: 001_initial_schema (workspaces)
--
-- Every DataForSEO response carries the cost of that call in `response.cost`,
-- and every Anthropic response carries its token counts. Both were discarded
-- everywhere except `lib/geo/ai-visibility.ts`, which records `costUsd` for its
-- own probes and is the only place in the product that can answer "what did
-- that cost".
--
-- Without this there is no way to answer the question the pricing depends on:
-- at 30 articles a month, does EUR 99 cover the API bill? The ladder in
-- apps/marketing/src/data/pricing.ts was set without a measured cost per
-- article, so the margin is currently an assumption.
--
-- Deliberately an append-only log rather than a running total on `workspaces`:
-- a total cannot be audited, and the question "why was last month expensive"
-- needs the individual calls.

CREATE TABLE IF NOT EXISTS provider_spend (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Null for work that is not attributable to one workspace, e.g. a readiness
  -- check run on a domain nobody has added yet.
  article_id uuid REFERENCES articles(id) ON DELETE SET NULL,

  provider text NOT NULL CHECK (provider IN ('dataforseo', 'anthropic', 'openai', 'pagespeed')),
  -- The endpoint or model, verbatim, so a spike can be traced to a caller.
  operation text NOT NULL,

  -- What the provider itself reported. NULL when the provider does not report a
  -- cost, which is different from a call that was free.
  cost_usd numeric(10, 6),
  input_tokens integer,
  output_tokens integer,

  -- Which run this belonged to, so a single generate can be totalled.
  run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_provider_spend_workspace
  ON provider_spend (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_provider_spend_run ON provider_spend (run_id);
CREATE INDEX IF NOT EXISTS idx_provider_spend_created ON provider_spend (created_at DESC);

COMMENT ON TABLE provider_spend IS
  'Append-only log of what each provider call cost. Source of truth for unit economics.';
COMMENT ON COLUMN provider_spend.cost_usd IS
  'As reported by the provider. NULL means the provider reported none, not that it was free.';

ALTER TABLE provider_spend ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Spend by agency" ON provider_spend
  FOR SELECT USING (
    workspace_id IN (
      SELECT w.id FROM workspaces w
      JOIN agency_members m ON m.agency_id = w.agency_id
      WHERE m.user_id = auth.uid()
    )
  );
