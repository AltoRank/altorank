-- 005: Featured images + brand style for AI image generation
-- Depends on: 001_initial_schema (articles, workspaces tables)

ALTER TABLE articles ADD COLUMN featured_image_url text;
ALTER TABLE workspaces ADD COLUMN brand_style jsonb DEFAULT '{}';
