-- 024: remember what the site publishes with
-- Depends on: 001_initial_schema (workspaces)
--
-- Onboarding asked people to pick their CMS out of twelve options and then find
-- an API key for it. The first half is a question the site itself can answer:
-- WordPress says so in a generator tag, Shopify in a response header, Webflow
-- in an attribute on <html>. `lib/cms/detect.ts` reads that from one public GET
-- during the first analysis, before anyone has connected anything.
--
-- Nullable with no default, and written only when detection actually matched.
-- NULL means "we could not tell", which is a real and common answer: a
-- hand-built site, a headless setup, or anything behind a CDN that strips the
-- fingerprints. altorank.co is one of them - Astro emits no generator tag. The
-- UI keeps the full picker in that case rather than guessing, because a wrong
-- platform sends someone hunting for credentials that do not exist.
--
-- Kept separate from `workspace_integrations`: this is what we observed, that
-- is what the user confirmed and authorised. A detection is a suggestion, never
-- a connection.

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS detected_platform text;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS detected_platform_at timestamptz;

COMMENT ON COLUMN workspaces.detected_platform IS
  'Publishing platform observed from public signals during analysis. NULL means undetermined; never a guess.';
COMMENT ON COLUMN workspaces.detected_platform_at IS
  'When the detection above was taken, so a stale reading is visible as stale.';
