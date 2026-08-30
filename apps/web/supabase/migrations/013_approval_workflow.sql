-- 013: Approval-first publishing
-- Depends on: 001_initial_schema (articles), 007_content_refresh (status check)
--
-- AltoRank's brand pillar is editorial-approval-by-design. Until now nothing
-- enforced approval before a CMS push (publishArticleCore had no status check;
-- `review` was just a label). This adds an explicit `approved` state so nothing
-- publishes — manual or cron — unless it was approved (or scheduled, which now
-- itself requires prior approval).

-- Expand the article status vocabulary to include 'approved'.
ALTER TABLE articles
  DROP CONSTRAINT IF EXISTS articles_status_check,
  ADD CONSTRAINT articles_status_check
    CHECK (status IN ('draft','drafting','review','approved','scheduled','live','error','archived'));

-- Sign-off record: who approved, and when.
ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;
