-- 093: claim-before-act for drafting a planned entry, and for what a checkout opens
-- Depends on: 001_initial_schema (calendar_entries, workspaces), 049_onboarding_plan (calendar_entries.keyword_id)
--
-- A trial-gated account gets one article before its trial and nothing more
-- (lib/billing/trial-hold.ts). When the trial starts, the rest of that week
-- is drafted straight away, one entry per request, and three writers can then
-- reach the same planned entry: the resume the checkout starts, a second
-- delivery of the same Stripe event, and the scheduled writer
-- (cron/generate). Each used to decide "this entry is free" from a read, and
-- a read is not a lock.
--
-- calendar_entries.draft_claimed_at / draft_claimed_by
--   One conditional UPDATE claims an entry before anybody writes it
--   (lib/plan/draft-claim.ts); exactly one concurrent caller matches. The
--   claim names its writer so the draft route can check it still holds it.
--   A claim older than the lease (15 minutes) with no article is a writer
--   that died, and the scheduled writer takes the entry back.
--
-- calendar_entries.draft_failed_at / draft_failure
--   Why the last writer did not produce an article, in words, for the
--   calendar. An entry with a failure is due to the next scheduled run
--   whatever its date, so nothing the resume could not write is lost.
--
-- calendar_entries.draft_owed_at
--   The trial start owes this entry a draft now, whatever its date: it is in
--   the week the trial opened (lib/plan/resume-week.ts). The resume drafts
--   these one request each; if that chain is cut off, the next scheduled run
--   finds them still owed and starts it again, rather than leaving each one
--   for its own day.
--
-- workspaces.trial_resume_key / trial_resume_claimed_at / trial_resumed_at
--   What a checkout owes a site - the month's top-up and, for a trial, the
--   rest of the week - as a record, not a hope. The Stripe webhook writes the
--   key (the subscription id) inside its own request, so a failure there is a
--   500 Stripe retries. The resume claims it with a lease
--   (`trial_resume_claimed_at`) and stamps `trial_resumed_at` only once the
--   work has run, so a resume cut off halfway is claimable again after the
--   lease and the scheduled writer's run re-sends it; a finished one is never
--   run twice for the same subscription.
--
-- Additive and nullable throughout: existing rows read as never claimed, never
-- failed, never owed, never resumed, which is what they are. The partial
-- indexes keep "how many are being written right now" and "what is still
-- owed" off a scan of every entry.

alter table calendar_entries
  add column if not exists draft_claimed_at timestamptz,
  add column if not exists draft_claimed_by text,
  add column if not exists draft_failed_at timestamptz,
  add column if not exists draft_failure text,
  add column if not exists draft_owed_at timestamptz;

comment on column calendar_entries.draft_claimed_at is
  'When a writer claimed this entry to draft it (lib/plan/draft-claim.ts). Null = never claimed.';
comment on column calendar_entries.draft_claimed_by is
  'Which writer holds the claim: cron:<run>, trial:<subscription id> or resume:<run>.';
comment on column calendar_entries.draft_failed_at is
  'When the last claimed draft of this entry failed. Non-null = due to the next scheduled run.';
comment on column calendar_entries.draft_failure is
  'Why the last claimed draft failed, as shown on the calendar.';
comment on column calendar_entries.draft_owed_at is
  'When a trial start put this entry in the week it drafts now (lib/plan/resume-week.ts). Non-null = due now, whatever its date.';

create index if not exists idx_calendar_entries_open_claims
  on calendar_entries (workspace_id, draft_claimed_at)
  where article_id is null and draft_claimed_at is not null;

create index if not exists idx_calendar_entries_owed
  on calendar_entries (workspace_id)
  where article_id is null and draft_owed_at is not null;

alter table workspaces
  add column if not exists trial_resume_key text,
  add column if not exists trial_resume_claimed_at timestamptz,
  add column if not exists trial_resumed_at timestamptz;

comment on column workspaces.trial_resume_key is
  'The Stripe subscription whose checkout follow-up (month top-up, rest of the week drafted) this site is owed or has had. Written by the webhook.';
comment on column workspaces.trial_resume_claimed_at is
  'When a resume last claimed this site''s follow-up. A claim older than the lease with no trial_resumed_at is a resume that was cut off.';
comment on column workspaces.trial_resumed_at is
  'When the follow-up for trial_resume_key finished running for this site. Null with a key = still owed.';
