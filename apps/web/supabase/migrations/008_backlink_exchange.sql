-- 008: Backlink exchange credit system
-- Depends on: 001_initial_schema (agencies, workspaces, articles tables)

CREATE TABLE backlink_exchanges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_agency_id uuid NOT NULL REFERENCES agencies(id),
  requester_workspace_id uuid NOT NULL REFERENCES workspaces(id),
  target_url text NOT NULL,
  target_keyword text,
  target_topic text,
  credits_offered integer NOT NULL DEFAULT 0,
  provider_agency_id uuid REFERENCES agencies(id),
  provider_workspace_id uuid REFERENCES workspaces(id),
  provider_article_id uuid REFERENCES articles(id),
  placement_url text,
  anchor_text text,
  relevance_score real,
  suggested_placement jsonb,
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','matched','accepted','placed','verified','live','rejected','expired')),
  matched_at timestamptz,
  placed_at timestamptz,
  verified_at timestamptz,
  expires_at timestamptz DEFAULT (now() + interval '30 days'),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE backlink_credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  amount integer NOT NULL,
  reason text NOT NULL CHECK (reason IN ('host_link','place_link','bonus','adjustment')),
  exchange_id uuid REFERENCES backlink_exchanges(id),
  dr_at_time integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_backlink_exchanges_requester ON backlink_exchanges(requester_agency_id, status);
CREATE INDEX idx_backlink_exchanges_provider ON backlink_exchanges(provider_agency_id) WHERE provider_agency_id IS NOT NULL;
CREATE INDEX idx_backlink_credits_agency ON backlink_credits(agency_id);
