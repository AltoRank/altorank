-- 082: system_events — one durable place where a failure is written down
-- Depends on: 001_initial_schema (agencies, workspaces)
--
-- This product has no error tracker and no product analytics. Everything it
-- knows about its own failures it knows in one of three ways, all of which
-- need somebody to already be looking:
--
--   * a `console.error` in a Vercel function log, which expires and which
--     nobody tails,
--   * a JSON response body a cron returns to Vercel's scheduler, which is
--     read by nothing,
--   * a status column on a row — `articles.status = 'error'`,
--     `onboarding_runs.status = 'partial'`, `publish_log.status = 'error'` —
--     which records the outcome of one object and says nothing about the run
--     that produced it.
--
-- On 2026-09-07 the first real customer stalled in onboarding, and the only
-- way that was discovered was by querying the production database by hand.
-- Nothing had failed loudly. Nothing ever does.
--
-- This table is the smallest fix that does not add a vendor: one row per
-- noteworthy thing that went wrong, written by lib/observability/record.ts,
-- read by the operator page at /admin/events and by the daily digest. It is a
-- log, not a source of truth — nothing in the product reads it to decide
-- anything, and losing it loses no work.
--
-- Deliberately NOT a new column on an existing table. `publish_log` is
-- per-article and per-publish, `onboarding_runs` is per-run and per-workspace,
-- `sent_emails` is a dedupe ledger with a composite primary key that would
-- reject a second failure of the same email; none of them can hold "the geo
-- cron threw", which has no article, no run and no recipient. One table with
-- a `source` string covers every failure mode at once, which is the point:
-- the operator asks "what broke today", not "what broke in publishing today".

create table if not exists system_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  -- error  something did not happen that should have
  -- warn   something finished, but short of what was asked (a `partial` run,
  --        a cron with per-item errors, a retry that was used up)
  -- info   a fact worth being able to count later; never used for noise
  level text not null check (level in ('info', 'warn', 'error')),

  -- Dotted, stable, and coarse enough to filter on: `cron.publish`,
  -- `email.deliver`, `stripe.webhook`, `agent.api`, `onboarding.run`,
  -- `cms.delivery`, `signup`. The recorder truncates it; the check keeps a
  -- caller from writing an entire error message here by accident.
  source text not null check (char_length(source) between 1 and 120),

  -- One line a person can read. Truncated to 500 characters by the recorder.
  message text not null,

  -- Whose site it was, when that is known. Null for a run-wide failure, and
  -- null is honest: it means "this was not about one account", never "we did
  -- not bother". Both are `on delete set null` — deleting a workspace must not
  -- delete the record that it once failed, and must not fail on this table.
  agency_id uuid references agencies(id) on delete set null,
  workspace_id uuid references workspaces(id) on delete set null,

  -- Whatever the call site had: counts, ids, a status code, the first line of
  -- a provider's refusal. Redacted and size-capped by the recorder.
  context jsonb not null default '{}'::jsonb
);

-- "What broke, most recent first" — the only query the page runs unfiltered.
create index if not exists system_events_created_at_idx
  on system_events (created_at desc);

-- "Only the errors", which is the digest's query and the page's default.
create index if not exists system_events_level_created_at_idx
  on system_events (level, created_at desc);

-- "Everything publishing did", the filter an operator reaches for second.
create index if not exists system_events_source_created_at_idx
  on system_events (source, created_at desc);

-- "Everything that went wrong for this site" — partial, because most rows
-- have no workspace and an index over those nulls would be dead weight.
create index if not exists system_events_workspace_created_at_idx
  on system_events (workspace_id, created_at desc)
  where workspace_id is not null;

alter table system_events enable row level security;

-- RLS on, no policies: the same posture as oauth_codes (080) and
-- agent_idempotency_keys (069). Every write is the service role
-- (lib/observability/record.ts always uses createServiceClient), and the only
-- reader is the operator page, which is gated on an operator email and reads
-- through the service client for exactly the reason the costs page does.
--
-- A customer-visible policy was considered and rejected for now: the rows
-- carry raw provider error text, and a select policy would be a promise that
-- some account-level activity feed exists to keep it honest. When one is
-- built, the policy to add is `agency_id in (select user_admin_agency_ids())`
-- — owner/admin only, the rule migration 072 established for everything at
-- agency scope that is not simply "what the dashboard shows you".
drop policy if exists "System events are service-role only" on system_events;

comment on table system_events is
  'Operational log: one row per failure or noteworthy outcome, written by lib/observability/record.ts and read by /admin/events and the daily operator digest. Never read to make a product decision; safe to prune.';
comment on column system_events.level is
  'error = something did not happen that should have; warn = finished short of what was asked (partial run, per-item errors, retries exhausted); info = a countable fact.';
comment on column system_events.source is
  'Dotted origin, e.g. cron.publish, email.deliver, stripe.webhook, agent.api, onboarding.run, cms.delivery, signup.';
comment on column system_events.context is
  'Structured detail from the call site. Key-shaped values are redacted and the whole object is size-capped before it is written.';
