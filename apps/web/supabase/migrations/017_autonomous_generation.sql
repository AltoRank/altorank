-- 017: Opt-in autonomous article generation
-- Depends on: 001_initial_schema (workspaces, articles)
--
-- Lets a workspace generate drafts on a schedule from the keyword
-- recommendation queue, without a human choosing the topic each time.
--
-- Two deliberate constraints:
--
--   Off by default. Autonomous generation spends the operator's Anthropic
--   budget and writes under their client's name. Defaulting it on would start
--   both without anyone asking for it.
--
--   Drafts only. There is no auto-publish flag here and there should not be
--   one. Generated articles land in `review` and go through the same approval
--   gate as everything else, which is the same reason the MCP server exposes no
--   publish tool: an unattended publish is precisely what the gate exists to
--   prevent.

ALTER TABLE workspaces ADD COLUMN auto_generate boolean NOT NULL DEFAULT false;

-- A ceiling, not a target. The cron writes at most this many drafts per rolling
-- week, so a misconfigured schedule or a retry storm cannot run up an API bill
-- or bury a reviewer in drafts they never asked for.
ALTER TABLE workspaces ADD COLUMN auto_generate_weekly_limit integer NOT NULL DEFAULT 2
  CHECK (auto_generate_weekly_limit BETWEEN 0 AND 20);

-- Distinguishes a draft the machine chose the topic for from one a human
-- requested. A reviewer should know which is which, and it keeps the weekly
-- limit honest when someone also generates by hand.
ALTER TABLE articles ADD COLUMN generated_autonomously boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN workspaces.auto_generate IS
  'Opt in to scheduled draft generation from the keyword recommendation queue. Drafts land in review; never published automatically.';
COMMENT ON COLUMN articles.generated_autonomously IS
  'True when the cron picked the keyword, false when a human did.';

-- Supports the weekly-limit count, which is the hot query in the cron.
CREATE INDEX idx_articles_autonomous_recent
  ON articles(workspace_id, created_at)
  WHERE generated_autonomously = true;
