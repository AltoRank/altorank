-- 010: Team email invites
-- Depends on: 001_initial_schema (agencies table)

CREATE TABLE invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL DEFAULT 'editor'
    CHECK (role IN ('owner','admin','editor')),
  token text NOT NULL UNIQUE,
  invited_by uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz
);

CREATE INDEX idx_invites_token ON invites(token) WHERE accepted_at IS NULL;
CREATE INDEX idx_invites_agency ON invites(agency_id);
