-- 038: Search Console metrics were readable by every signed-in account
-- Depends on: 006_analytics_metrics (the table), 001_initial_schema (user_agency_ids)
--
-- `analytics_metrics` was created in 006 without RLS and never gained it, so
-- it was the only table in its neighbourhood without a policy:
--
--     analytics_metrics    rls off   0 policies
--     keywords             rls on    1 policy
--     workspaces           rls on    1 policy
--     workspace_integrations rls on  1 policy
--
-- The `authenticated` role holds SELECT on it, so any account that had signed
-- in could read every other tenant's Search Console performance - the queries
-- their site ranks for, the clicks, the impressions, per URL - with the public
-- anon key and no exploit beyond asking for the rows. Verified against the
-- hosted project on 2026-09-02, where it was already holding real customer
-- data. SECURITY.md treats a path that leaks another account's data as a
-- finding, and this was one.
--
-- It also silently widened the product's own queries: `getTrafficSeries()`
-- takes an optional workspace id, and the call with none was scoped by nothing
-- at all, so any page that ever dropped the argument would have charted every
-- customer's clicks together and called it yours.
--
-- FOR ALL rather than FOR SELECT, deliberately. Connecting Search Console
-- backfills the last week through the *caller's* cookie client
-- (app/api/auth/google/callback/route.ts -> backfillAnalytics), which deletes
-- and inserts these rows as the signed-in user. A read-only policy would have
-- passed every test that only reads and then failed the connect flow in
-- production, which is the shape of bug this table already produced once.
-- Postgres applies USING to INSERT's WITH CHECK when the latter is omitted, so
-- one clause covers the read and the write, exactly as migration 001 does for
-- articles and keywords. The nightly cron holds the service role and bypasses
-- RLS regardless.

ALTER TABLE analytics_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Analytics by agency" ON analytics_metrics
  FOR ALL USING (
    workspace_id IN (
      SELECT id FROM workspaces WHERE agency_id IN (SELECT user_agency_ids())
    )
  );
