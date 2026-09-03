-- 040: the static-site publishing target
--
-- Numbered 035 until 2026-09-03, alongside 035_keyword_source.sql. Supabase
-- records the leading digits as `schema_migrations.version`, which is the
-- primary key, so two files sharing a prefix apply the first and then fail the
-- second on a duplicate key. That is why nothing past 032 had ever reached the
-- hosted project: the push died before it got here.
--
-- This file moved rather than the other one because 036_keyword_source_gap.sql
-- rewrites the constraint 035_keyword_source.sql creates and has to follow it.
-- This one is a single idempotent insert that nothing else depends on, so it
-- is safe anywhere in the order.
--
-- lib/cms/git.ts and its adapter existed since the CMS layer was written, but
-- three things had to be true for anyone to use it and only two ever were: the
-- adapter resolved, the connect form did not offer it, and this row did not
-- exist. Without the row, ConnectActions falls back to cmsIntegrations[0] and
-- would file a git connection under WordPress - it would publish, because
-- publishArticleCore resolves the adapter from config.type, but the dashboard
-- would name the wrong platform back at you.
--
-- Covers Astro, Next, Hugo, Jekyll and Eleventy, which lib/cms/detect.ts
-- already identifies and routes here.
insert into integrations (id, name, tag, description, icon_key) values
  ('git', 'Git / static site', 'CMS', 'Commits Markdown to your repo; your host builds and deploys it', 'git')
on conflict (id) do nothing;
