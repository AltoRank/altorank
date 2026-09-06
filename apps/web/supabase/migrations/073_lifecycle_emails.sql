-- 073: the ledger that stops a lifecycle email being sent twice, the
--      preferences that let somebody stop receiving one, and one pending
--      invite per address.
-- Depends on: 001_initial_schema (agencies, workspaces), 010_invites
--
-- Every lifecycle email added in this change has a trigger that can run more
-- than once for the same fact:
--
--   a Stripe webhook is retried until it gets a 200, and a failing card
--   produces a fresh `invoice.payment_failed` event on every retry Stripe
--   makes for days
--   the generate cron runs four times a day over the same workspaces
--   the publish cron runs every fifteen minutes over the same articles
--   a server action can be double-submitted
--
-- Without a record of what has already gone out, "your payment failed" arrives
-- every few hours for a week. A duplicate transactional email reads as a bug
-- in the product, not as a mailing-list mistake, so the ledger is written
-- *before* the send and rolled back if the send fails, rather than written
-- after and hoped for.
--
-- Service-role only, like agent_idempotency_keys (069): the crons and webhook
-- write it and nothing in the UI reads it, so RLS is on with no policies.
create table if not exists sent_emails (
  -- What kind of email: a stable slug from lib/email/lifecycle.ts, never a
  -- subject line (subjects carry the site's name and would not match on a
  -- rename).
  email_type text not null,
  -- The thing the email is about: an article id, an agency id plus the
  -- timestamp of the failure run, a workspace id plus an ISO week. Whatever
  -- identifies "this fact", so a second email about the same fact is a
  -- duplicate and one about a new fact is not.
  subject_id text not null,
  -- Per address, so adding a colleague to the account still tells them about
  -- the next thing, and a resend to somebody who was already told does not
  -- happen.
  recipient text not null,
  agency_id uuid references agencies(id) on delete set null,
  workspace_id uuid references workspaces(id) on delete set null,
  sent_at timestamptz not null default now(),
  primary key (email_type, subject_id, recipient)
);

create index if not exists idx_sent_emails_sent_at on sent_emails (sent_at);
create index if not exists idx_sent_emails_agency on sent_emails (agency_id);

alter table sent_emails enable row level security;

comment on table sent_emails is
  'One row per lifecycle email actually delivered, keyed by (type, subject, recipient). Claimed before the send and deleted if the send fails, so a retried webhook or a re-run cron cannot double-send.';

-- ---------------------------------------------------------------------------
-- Who does not want to hear about it
-- ---------------------------------------------------------------------------
--
-- Until now no email the app sends carried an unsubscribe link and there was
-- nowhere to record the wish. The only opt-out offered was in the draft-ready
-- mail's own footer - "turn off automatic drafting for this site" - which is
-- account-wide, owner-only, and stops the work rather than the mail.
--
-- Keyed by address, not by user id: the monthly report goes to
-- `agencies.report_email`, which may be a shared inbox with no account behind
-- it, and that inbox has the same right to stop the mail as a member does.
--
-- Only the *optional* categories can be turned off (lib/email/categories.ts).
-- A password-reset link, a confirmation link and a failed-payment notice are
-- not marketing; a customer who has switched them off and then cannot get into
-- their account has been failed by us, not served.
create table if not exists email_preferences (
  email text primary key,
  -- Category slugs, plus the pseudo-category 'all'. Empty array = everything on.
  unsubscribed text[] not null default '{}',
  updated_at timestamptz not null default now()
);

alter table email_preferences enable row level security;

comment on table email_preferences is
  'Per-address opt-outs for the optional email categories (drafts, publishing, improvements, reports, product). Written by /api/unsubscribe; read before every optional send. Required categories ignore it.';

-- ---------------------------------------------------------------------------
-- One pending invite per address
-- ---------------------------------------------------------------------------
--
-- `invites` was unique on the token only, so pressing Invite twice for the
-- same colleague wrote a second row and sent a second email, and the Team page
-- listed the address twice with two links that both worked. The action now
-- reuses the pending row (and its token) and re-sends, which is what a second
-- press means; this index is what makes that the only possible outcome.
--
-- Existing duplicates are collapsed first, keeping the invite that expires
-- last - the most recently issued one, which is the link the person was most
-- recently sent.
delete from invites i
using invites j
where i.accepted_at is null
  and j.accepted_at is null
  and i.agency_id = j.agency_id
  and lower(i.email) = lower(j.email)
  and (i.expires_at, i.id) < (j.expires_at, j.id);

create unique index if not exists idx_invites_one_pending_per_email
  on invites (agency_id, lower(email))
  where accepted_at is null;
