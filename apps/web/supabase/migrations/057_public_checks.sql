-- 057: the free public agent-readiness check, cached by domain
-- Depends on: nothing (keyed by domain, no account exists)
--
-- Anyone can type a domain at altorank.co/check or open a shared result at
-- app.altorank.co/check/<domain>. Each run fetches four URLs on someone
-- else's site, so a shared link that re-crawled on every open would make the
-- reader pay for the sharer's curiosity. Caching by domain bounds the crawl
-- to once per TTL and gives the share page and the badge something to read
-- without touching the site at all.
--
-- Nothing personal is stored. The domain is a public hostname and `result` is
-- what the checker observed on that site's public configuration (robots.txt,
-- sitemap, llms.txt, homepage head). Emails offered alongside a check go to
-- tool_leads (012), not here.

CREATE TABLE IF NOT EXISTS public_checks (
  domain text PRIMARY KEY,
  -- Null when the checks that completed do not support a number (rule 5:
  -- unknown is never written down as zero).
  score integer,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS public_checks_created_at_idx ON public_checks (created_at);

-- Only the service role reads or writes this; the browser goes through the
-- route, which decides what to show.
ALTER TABLE public_checks ENABLE ROW LEVEL SECURITY;
