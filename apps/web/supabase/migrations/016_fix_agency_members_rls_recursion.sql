-- 016: Break the infinite recursion in the agency_members RLS policy
-- Depends on: 001_initial_schema (agency_members, user_agency_ids)
--
-- Symptom: every authenticated read of `agency_members` fails with
--   ERROR: infinite recursion detected in policy for relation "agency_members"
--
-- Consequence, which is why this is not cosmetic: `POST /api/generate` verifies
-- membership with
--
--   supabase.from("agency_members").select("id").eq("agency_id", ...)
--
-- through the RLS-scoped client. That select raises, the membership comes back
-- empty, and the route returns 403. No user could generate an article through
-- the dashboard, no matter how correctly their account was provisioned. The
-- same check guards several other routes and server actions.
--
-- Cause: 001 created two policies on the table. The SELECT policy correctly
-- routes through `user_agency_ids()`, which is SECURITY DEFINER and therefore
-- exempt from RLS. The second policy, "Owners manage members", is FOR ALL (so
-- it also applies to SELECT) and inlines its own subquery against
-- `agency_members`. That subquery is evaluated under the very policy being
-- defined, so Postgres detects the cycle and aborts.
--
-- Fix: give the owner/admin check the same SECURITY DEFINER treatment. The
-- function is the only thing allowed to read the table without a policy, and
-- both policies now go through one.

CREATE OR REPLACE FUNCTION public.user_admin_agency_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT agency_id
  FROM agency_members
  WHERE user_id = auth.uid()
    AND role IN ('owner', 'admin');
$$;

DROP POLICY IF EXISTS "Owners manage members" ON agency_members;

CREATE POLICY "Owners manage members" ON agency_members
  FOR ALL
  USING (agency_id IN (SELECT user_admin_agency_ids()))
  WITH CHECK (agency_id IN (SELECT user_admin_agency_ids()));

-- `user_agency_ids()` predates this and lacks an explicit search_path, which is
-- the standard hardening for a SECURITY DEFINER function: without it the
-- function resolves unqualified names against the caller's search_path.
CREATE OR REPLACE FUNCTION public.user_agency_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT agency_id FROM agency_members WHERE user_id = auth.uid();
$$;
