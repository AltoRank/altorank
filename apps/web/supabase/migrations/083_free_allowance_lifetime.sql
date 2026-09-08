-- 083: the free drafts become a one-time seven, not seven every month
-- Depends on: 001_initial_schema (agencies, workspaces, articles)
--
-- FREE_DRAFTS has always been counted per calendar month, refilling on the 1st
-- and never expiring (lib/billing/quota.ts). That is a standing free tier: an
-- account could take seven drafts a month forever, and every paid action
-- around them - keyword research, re-crawls, SERP and backlink lookups, voice
-- training - was open for the same forever, because nothing but generation and
-- publishing was gated at all.
--
-- The rule is now: seven drafts, once, and then a plan. `free_drafts_used` is
-- the durable count of what has been spent against that one-time allowance.
--
-- Why a column and not a `count(*)` over articles:
--
--   Deleting an article used to give the month's quota back, which was
--   "acceptable at this scale and honest in both directions" while the counter
--   refilled anyway. Against a lifetime allowance the same behaviour is an
--   unbounded refill: delete the seven, take seven more. A stored counter is
--   the only thing a delete cannot walk backwards.
--
-- The reader takes `max(free_drafts_used, articles ever created)`, so the
-- column is a floor rather than the sole truth: a generation path that forgets
-- to increment it is caught by the live count instead of handing out a free
-- draft nobody recorded.
--
-- Backfill: every existing agency starts at the number of articles its
-- workspaces have ever produced. An account that took seven drafts in August
-- and seven more in September is at 14 and is out of allowance the moment this
-- deploys - which is the intended rule, not an accident. It is not a silent
-- lock: `freeAllowanceUsedMessage` says the allowance is one-time and that
-- these were spent under the old monthly rule, so the account is told what
-- changed rather than finding a button that stopped working.
--
-- Paid accounts are unaffected: their limit is the plan's monthly volume and
-- is still counted per calendar month. This column is only read on the
-- `no-plan` branch.
--
-- Idempotent: `add column if not exists`, and the backfill only writes rows
-- still sitting at the default 0.

alter table agencies
  add column if not exists free_drafts_used integer not null default 0;

alter table agencies
  drop constraint if exists agencies_free_drafts_used_check,
  add constraint agencies_free_drafts_used_check
    check (free_drafts_used >= 0);

comment on column agencies.free_drafts_used is
  'Drafts spent against the one-time free allowance (FREE_DRAFTS, lib/billing/quota.ts). Never reset and never decremented: deleting an article does not return a free draft. Incremented by generateArticle when the account has no plan. Ignored on paid accounts, whose limit is the plan''s monthly volume.';

-- Backfill from what each agency has actually produced. Left alone for any
-- agency already carrying a non-zero count, so re-running this is a no-op.
update agencies a
set free_drafts_used = coalesce(
  (
    select count(*)
    from articles ar
    join workspaces w on w.id = ar.workspace_id
    where w.agency_id = a.id
  ),
  0
)
where a.free_drafts_used = 0;
