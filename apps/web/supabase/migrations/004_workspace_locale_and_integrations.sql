-- 004: Add locale to workspaces + seed additional CMS integrations
-- Depends on: 001_initial_schema (workspaces, integrations tables)

-- Workspace locale support
ALTER TABLE workspaces
  ADD COLUMN language text NOT NULL DEFAULT 'en',
  ADD COLUMN location_code integer NOT NULL DEFAULT 2840;

-- Seed additional CMS integrations
INSERT INTO integrations (id, name, tag, description, icon_key) VALUES
  ('webflow',      'Webflow',      'CMS', 'Blog posts via CMS API v2',                       'webflow'),
  ('ghost',        'Ghost',        'CMS', 'Posts via Ghost Admin API',                        'ghost'),
  ('framer',       'Framer',       'CMS', 'CMS collection items via Framer API',              'framer'),
  ('wix',          'Wix',          'CMS', 'Blog posts via Wix Blog API v3',                   'wix'),
  ('notion',       'Notion',       'CMS', 'Pages via Notion API',                             'notion'),
  ('hubspot',      'HubSpot',      'CMS', 'Blog posts via CMS API v3',                        'hubspot'),
  ('woocommerce',  'WooCommerce',  'CMS', 'Blog posts via WordPress REST API',                'woocommerce'),
  ('webhook',      'Webhook',      'CMS', 'Generic webhook for any CMS or custom endpoint',   'webhook')
ON CONFLICT (id) DO NOTHING;
