-- 007: Content refresh / decay detection
-- Depends on: 001_initial_schema (articles table)

-- Expand article status to include 'archived'
ALTER TABLE articles
  DROP CONSTRAINT IF EXISTS articles_status_check,
  ADD CONSTRAINT articles_status_check
    CHECK (status IN ('draft','drafting','review','scheduled','live','error','archived'));

-- Track which article a refresh replaces
ALTER TABLE articles ADD COLUMN replaces_article_id uuid REFERENCES articles(id);
