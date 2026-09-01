-- 029: the free growth plan, cached by domain
-- Depends on: nothing (keyed by domain, no workspace exists yet)
--
-- The homepage hook lets anyone type a domain and get a plan back. Each plan
-- costs three or four DataForSEO calls, and a public endpoint with no memory
-- is a bill with no ceiling. Caching by domain does two jobs at once: a repeat
-- visitor (or the same visitor refreshing) gets an instant answer, and the
-- spend for a domain is bounded to once per TTL however many times it is asked.
--
-- Keyed by domain rather than by who asked: the plan is a fact about a public
-- site, not about a visitor, so there is nothing personal to key on. Rows are
-- expected to be short-lived; the route treats anything older than the TTL as
-- absent and overwrites it.

CREATE TABLE IF NOT EXISTS growth_plans (
  domain text PRIMARY KEY,
  plan jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS growth_plans_created_at_idx ON growth_plans (created_at);

-- Only the service role reads or writes this; nothing in the browser touches
-- it directly.
ALTER TABLE growth_plans ENABLE ROW LEVEL SECURITY;
