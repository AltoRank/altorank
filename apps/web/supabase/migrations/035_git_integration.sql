-- The static-site publishing target.
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
