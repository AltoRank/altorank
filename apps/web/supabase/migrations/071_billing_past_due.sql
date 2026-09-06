-- 066: when the last renewal failed, so the grace window has a start.
--
-- A failed renewal makes Stripe report the subscription `past_due`, and until
-- now that status turned the account into a free one on the spot. The paid
-- tier now stays open for a fixed window from the failed invoice
-- (lib/billing/dunning.ts, GRACE_DAYS), which needs the failure's timestamp
-- on the row. Written by the Stripe webhook on `invoice.payment_failed` and
-- on a subscription going past due; cleared on `invoice.paid` and on the
-- subscription returning to `active`. NULL = nothing is failing.

alter table agencies
  add column if not exists payment_failed_at timestamptz;

comment on column agencies.payment_failed_at is
  'When the current run of failed renewals started (first invoice.payment_failed). NULL = paid up. The paid tier stays entitled for GRACE_DAYS from here.';

-- Stripe's own vocabulary for the state, alongside past_due. The webhook
-- folds `unpaid` into `past_due` today; the check is widened so a future
-- version can store it verbatim without a migration.
alter table agencies drop constraint if exists agencies_plan_status_check;
alter table agencies
  add constraint agencies_plan_status_check
  check (plan_status in ('inactive', 'trialing', 'active', 'past_due', 'unpaid', 'canceled'));
