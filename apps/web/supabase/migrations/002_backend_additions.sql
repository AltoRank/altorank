-- AltoRank backend additions
-- New columns, tables, seed data, and RLS for AI generation, CMS publishing, SEO pipeline

-- === New columns on existing tables ===

alter table articles
  add column external_id text,
  add column published_url text,
  add column meta_description text,
  add column ai_provider text,
  add column generation_id uuid;

alter table workspaces
  add column ai_provider text default 'claude',
  add column ai_model text;

-- === Generation Jobs ===
create table generation_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  article_id uuid references articles(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed')),
  ai_provider text not null default 'claude',
  prompt_config jsonb default '{}',
  result jsonb,
  error text,
  tokens_used integer default 0,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz default now()
);

-- === Keyword Rankings (SERP history) ===
create table keyword_rankings (
  id uuid primary key default gen_random_uuid(),
  keyword_id uuid not null references keywords(id) on delete cascade,
  position integer not null,
  url text,
  checked_at timestamptz default now()
);

-- === SEO Audits ===
create table seo_audits (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references articles(id) on delete cascade,
  score integer not null default 0,
  checks jsonb default '{}',
  created_at timestamptz default now()
);

-- === Seed integrations reference data ===
insert into integrations (id, name, tag, description, icon_key) values
  ('wordpress', 'WordPress', 'CMS', 'Publish posts, categories, featured images, SEO plugin fields', 'wordpress'),
  ('shopify',   'Shopify',   'CMS', 'Blog articles, product-linked posts, metafields', 'shopify'),
  ('magento',   'Magento',   'CMS', 'CMS pages and blog posts via REST API', 'magento'),
  ('webflow',   'Webflow',   'CMS', 'CMS collection items + binding to your blog template', 'webflow'),
  ('ghost',     'Ghost',     'CMS', 'Posts + tags + feature image + members visibility', 'ghost'),
  ('framer',    'Framer',    'CMS', 'CMS item sync with your blog template slots', 'framer'),
  ('notion',    'Notion',    'CMS', 'Post to a database; map title / body / cover / tags', 'notion'),
  ('wix',       'Wix',       'CMS', 'Blog posts + collections; use existing category taxonomy', 'wix'),
  ('ga4',       'GA4',       'Analytics', 'Traffic + engagement, auto-attributed to each article', 'ga4'),
  ('gsc',       'Search Console', 'Analytics', 'Clicks, impressions, average position per URL', 'gsc'),
  ('ahrefs',    'Ahrefs',    'Data', 'Rank tracking + backlink index for each workspace', 'ahrefs'),
  ('slack',     'Slack',     'Notify', 'Pipe approvals, publishes and failures to any channel', 'slack'),
  ('zapier',    'Zapier',    'Automate', '3,000+ downstream destinations via zap triggers', 'zapier')
on conflict (id) do nothing;

-- === RLS on new tables ===

alter table generation_jobs enable row level security;
alter table keyword_rankings enable row level security;
alter table seo_audits enable row level security;

-- Generation jobs: scoped via workspace → agency
create policy "Generation jobs by agency" on generation_jobs
  for all using (
    workspace_id in (select id from workspaces where agency_id in (select user_agency_ids()))
  );

-- Keyword rankings: scoped via keyword → workspace → agency
create policy "Keyword rankings by agency" on keyword_rankings
  for all using (
    keyword_id in (
      select id from keywords where workspace_id in (
        select id from workspaces where agency_id in (select user_agency_ids())
      )
    )
  );

-- SEO audits: scoped via article → workspace → agency
create policy "SEO audits by agency" on seo_audits
  for all using (
    article_id in (
      select id from articles where workspace_id in (
        select id from workspaces where agency_id in (select user_agency_ids())
      )
    )
  );

-- === FK from articles.generation_id to generation_jobs ===
alter table articles
  add constraint articles_generation_id_fkey
  foreign key (generation_id) references generation_jobs(id) on delete set null;

-- === Unique constraints for upsert operations ===
create unique index keywords_workspace_term on keywords (workspace_id, term);
create unique index backlinks_workspace_source_target on backlinks (workspace_id, source_domain, target_url);
