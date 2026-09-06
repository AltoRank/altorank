-- 069: idempotency keys for POST /api/agent/v1/articles/generate
-- Depends on: 001_initial_schema (agencies, articles), 051_api_keys
--
-- Generation runs after the 202 and is bounded by the route's maxDuration.
-- An agent whose connection timed out could not tell "the draft started"
-- from "nothing happened", and a retry inserted a second `drafting` row and
-- spent quota twice. The agent now sends an Idempotency-Key; the first call
-- claims (agency, key) here and binds it to the article it created, and a
-- repeat within 24 hours gets that article back instead of a new one.
--
-- Service-role only: the agent API has no user session, so RLS is on with no
-- policies, the same posture as public_checks (057).
create table if not exists agent_idempotency_keys (
  agency_id uuid not null references agencies(id) on delete cascade,
  key text not null,
  -- Null between the claim and the insert of the article row, a window of
  -- one statement. A deleted article frees its key: a retry after that is a
  -- new request, not a replay of a draft that no longer exists.
  article_id uuid references articles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (agency_id, key)
);

create index if not exists idx_agent_idempotency_keys_created
  on agent_idempotency_keys (created_at);

alter table agent_idempotency_keys enable row level security;

comment on table agent_idempotency_keys is
  'One row per Idempotency-Key an agent sent to POST /articles/generate, bound to the article it started. Rows older than 24h are ignored and reclaimed on the next use of the key.';
