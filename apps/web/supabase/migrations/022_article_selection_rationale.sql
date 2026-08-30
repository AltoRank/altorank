-- 022: why a draft exists, kept with the draft
-- Depends on: 001_initial_schema (articles), 017_autonomous_generation
--
-- lib/seo/recommendations.ts already computes a plain-language explanation for
-- every keyword it picks, and says in its own header why that matters:
--
--   "A model call here would be non-reproducible and would make the ordering
--    unexplainable at exactly the moment a human wants to know 'why is it
--    writing about this?'"
--
-- That explanation was then thrown away. It survived only as the first element
-- of reasons[] interpolated into an activity-log line in cron/generate. Open the
-- article itself and there was no answer to "why does this exist?", which is the
-- one question a reviewer has to answer before approving anything.
--
-- Same for scoring: lib/seo/scoring.ts computes 11 named checks with per-check
-- notes, and app/actions/seo.ts persisted only the aggregate number. We tell
-- people on the marketing site that our scoring is auditable rather than a
-- black box; the reviewer was looking at a black box.
--
-- These columns store the rationale AS IT WAS AT THE MOMENT OF CHOOSING, which
-- is deliberate. Recomputing later would answer a different question: keyword
-- data moves, competitors publish, positions change. The reviewer needs to know
-- why the machine picked this then, not what the machine would pick now.

ALTER TABLE articles
  -- Ordered plain-language reasons from KeywordRecommendation.reasons.
  ADD COLUMN IF NOT EXISTS selection_reasons jsonb,
  -- KeywordRecommendation.score. Only meaningful relative to the other
  -- candidates in the same run, which the UI has to say out loud.
  ADD COLUMN IF NOT EXISTS selection_score numeric,
  -- Nullable ON PURPOSE. Difficulty is genuinely unknown until a provider
  -- returns it, and this repo has been bitten four times by defaulting an
  -- unmeasured number to 0: the UI colours anything under 25 green, so every
  -- keyword read as trivially winnable. Render em dash, never zero.
  ADD COLUMN IF NOT EXISTS keyword_difficulty integer,
  -- The full ScoringResult.checks array: name, passed, score, note.
  ADD COLUMN IF NOT EXISTS seo_checks jsonb;

COMMENT ON COLUMN articles.selection_reasons IS
  'Why the autonomous queue chose this keyword, captured at selection time. Null for manually created articles and for anything generated before migration 022.';
COMMENT ON COLUMN articles.keyword_difficulty IS
  'Nullable. NULL means not measured, which is not the same as 0. Never coalesce this to zero for display.';
COMMENT ON COLUMN articles.seo_checks IS
  'Full per-check breakdown from lib/seo/scoring.ts, so the reviewer can see which of the 11 checks failed rather than only the aggregate seo_score.';
