-- 033: the Google connection belongs to the account, not to one workspace
-- Depends on: 001_initial_schema (agencies)
--
-- Tokens were stored per workspace, which made a chicken and egg: connecting
-- required a workspace, but the properties the account owns are exactly what
-- you would want to create workspaces from. One consent, stored once, then
-- each workspace resolves its own property from it.

CREATE TABLE IF NOT EXISTS agency_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google')),
  tokens jsonb NOT NULL,
  connected_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agency_id, provider)
);

ALTER TABLE agency_integrations ENABLE ROW LEVEL SECURITY;

-- Tokens are read by server code holding the service role. A member may see
-- that a connection exists, never the tokens themselves.
CREATE POLICY "Members see their own account's connections" ON agency_integrations
  FOR SELECT USING (agency_id IN (SELECT agency_id FROM agency_members WHERE user_id = auth.uid()));

COMMENT ON TABLE agency_integrations IS 'One Google consent per account; workspaces resolve their own property from it.';
