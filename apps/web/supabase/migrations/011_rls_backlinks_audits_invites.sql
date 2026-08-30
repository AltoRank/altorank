-- 011: Enable RLS on tables added in migrations 008-010
-- Depends on: 008_backlink_exchange, 009_domain_audits, 010_invites, user_agency_ids() from 001

-- ============================================================
-- backlink_exchanges
-- ============================================================
ALTER TABLE backlink_exchanges ENABLE ROW LEVEL SECURITY;

-- Users can see exchanges where their agency is requester OR provider
CREATE POLICY "Exchanges visible to requester or provider agency" ON backlink_exchanges
  FOR SELECT USING (
    requester_agency_id IN (SELECT user_agency_ids())
    OR provider_agency_id IN (SELECT user_agency_ids())
  );

-- Only requester agency can create exchange requests
CREATE POLICY "Requester agency creates exchanges" ON backlink_exchanges
  FOR INSERT WITH CHECK (
    requester_agency_id IN (SELECT user_agency_ids())
  );

-- Requester or provider agency can update exchanges they're part of
CREATE POLICY "Participants update exchanges" ON backlink_exchanges
  FOR UPDATE USING (
    requester_agency_id IN (SELECT user_agency_ids())
    OR provider_agency_id IN (SELECT user_agency_ids())
  );

-- Only requester agency can delete their own exchange requests
CREATE POLICY "Requester agency deletes exchanges" ON backlink_exchanges
  FOR DELETE USING (
    requester_agency_id IN (SELECT user_agency_ids())
  );

-- ============================================================
-- backlink_credits
-- ============================================================
ALTER TABLE backlink_credits ENABLE ROW LEVEL SECURITY;

-- Users can only see credits for their own agency
CREATE POLICY "Credits scoped to agency" ON backlink_credits
  FOR SELECT USING (
    agency_id IN (SELECT user_agency_ids())
  );

-- Credits are inserted programmatically but scoped to own agency
CREATE POLICY "Credits insert scoped to agency" ON backlink_credits
  FOR INSERT WITH CHECK (
    agency_id IN (SELECT user_agency_ids())
  );

-- ============================================================
-- domain_audits
-- ============================================================
ALTER TABLE domain_audits ENABLE ROW LEVEL SECURITY;

-- Users can see/manage audits for workspaces in their agency
CREATE POLICY "Audits by agency" ON domain_audits
  FOR ALL USING (
    workspace_id IN (
      SELECT id FROM workspaces WHERE agency_id IN (SELECT user_agency_ids())
    )
  );

-- ============================================================
-- invites
-- ============================================================
ALTER TABLE invites ENABLE ROW LEVEL SECURITY;

-- Agency members can see invites for their agency
CREATE POLICY "Invites visible to agency members" ON invites
  FOR SELECT USING (
    agency_id IN (SELECT user_agency_ids())
  );

-- Only agency members can create invites for their agency
CREATE POLICY "Agency members create invites" ON invites
  FOR INSERT WITH CHECK (
    agency_id IN (SELECT user_agency_ids())
  );

-- Agency members can update invites (e.g. mark accepted)
CREATE POLICY "Agency members update invites" ON invites
  FOR UPDATE USING (
    agency_id IN (SELECT user_agency_ids())
  );

-- Agency members can delete invites for their agency
CREATE POLICY "Agency members delete invites" ON invites
  FOR DELETE USING (
    agency_id IN (SELECT user_agency_ids())
  );
