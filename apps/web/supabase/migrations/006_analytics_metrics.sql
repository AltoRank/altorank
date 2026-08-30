-- 006: Analytics metrics for GA4 + Google Search Console data
-- Depends on: 001_initial_schema (workspaces, articles tables)

CREATE TABLE analytics_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  article_id uuid REFERENCES articles(id) ON DELETE SET NULL,
  source text NOT NULL CHECK (source IN ('ga4', 'gsc')),
  metric_date date NOT NULL,
  pageviews integer DEFAULT 0,
  sessions integer DEFAULT 0,
  clicks integer DEFAULT 0,
  impressions integer DEFAULT 0,
  ctr numeric(5,4) DEFAULT 0,
  avg_position numeric(6,2),
  page_url text,
  query text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_analytics_metrics_workspace ON analytics_metrics(workspace_id, metric_date);
CREATE INDEX idx_analytics_metrics_article ON analytics_metrics(article_id) WHERE article_id IS NOT NULL;

-- Store Google OAuth tokens (encrypted at application layer)
ALTER TABLE workspace_integrations ADD COLUMN tokens jsonb;
