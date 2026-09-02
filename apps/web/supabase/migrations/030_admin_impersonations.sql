-- 030: who opened whose account
-- Depends on: nothing in public. Deliberately no foreign keys to auth.users:
-- an audit row must outlive the accounts it names, and ON DELETE CASCADE
-- would erase the trail the moment a customer deleted their account.
--
-- Operators can open the product as any account (app/actions/impersonation.ts,
-- "View as" on /admin/users). That is full access to a customer's data, not a
-- read-only view, and the only thing that makes it acceptable is that every
-- use is on record: who, whose, when, and how it ended.
--
-- Append-only. `ended_at` and `end_reason` are filled in once, by the stop
-- action or by the failure that cut the attempt short; nothing else updates
-- or deletes here.

CREATE TABLE IF NOT EXISTS admin_impersonations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_user_id uuid NOT NULL,
  operator_email text NOT NULL,
  target_user_id uuid NOT NULL,
  target_email text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  -- 'stopped' when the operator came back through the banner. Anything else
  -- is the error that ended the attempt. NULL while the session is open.
  end_reason text
);

CREATE INDEX IF NOT EXISTS idx_admin_impersonations_started
  ON admin_impersonations (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_impersonations_target
  ON admin_impersonations (target_user_id, started_at DESC);

COMMENT ON TABLE admin_impersonations IS
  'Every time an operator opened the product as another account. Append-only audit log; no FK so rows outlive the accounts.';

-- RLS on, no policies: nothing but the service role reads or writes this
-- table. The operator pages run on the service client because they are
-- cross-account by definition, and a customer should not be able to see who
-- has looked at whom, including themselves, through the anon key.
ALTER TABLE admin_impersonations ENABLE ROW LEVEL SECURITY;
