-- 014: Stripe billing — subscription status + renewal tracking.
-- agencies already has plan, stripe_customer_id, stripe_subscription_id (001).
-- This adds the Stripe-synced subscription state the webhook keeps up to date.

ALTER TABLE agencies
  ADD COLUMN IF NOT EXISTS plan_status text NOT NULL DEFAULT 'inactive'
    CHECK (plan_status IN ('inactive','trialing','active','past_due','canceled')),
  ADD COLUMN IF NOT EXISTS current_period_end timestamptz;
