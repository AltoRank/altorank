-- Onboarding that ends on a plan.
--
-- The wizard (048) collected a business profile and threw away three of its
-- five screens: the sitemap and blog address were template strings, the
-- article settings were never read, and finishing landed on an empty dashboard.
-- This gives every screen somewhere to write and gives the calendar something
-- to show before the first article exists.
--
-- `onboarded_at` / `onboarding_skipped_at` are what route a new account into the
-- wizard and out of it. They live on the workspace, not in user metadata: the
-- wizard configures a site, and a second member of the same agency should not
-- be asked to do it again.

alter table workspaces
  add column if not exists sitemap_url text,
  add column if not exists blog_root_url text,
  add column if not exists example_article_urls text[] not null default '{}',
  add column if not exists onboarded_at timestamptz,
  add column if not exists onboarding_skipped_at timestamptz;

comment on column workspaces.sitemap_url is 'Discovered or confirmed in onboarding; the internal-link source.';
comment on column workspaces.blog_root_url is 'Where published articles appear on the site.';
comment on column workspaces.example_article_urls is 'Up to three URLs the owner considers their best writing; voice-training input.';

-- How articles should read, per site. Every flag is a prompt switch; nothing
-- here changes what publishes, and there is deliberately no auto-publish column.
create table if not exists workspace_output_settings (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  tone text not null default 'informative'
    check (tone in ('informative','simple','formal','casual','enthusiastic','persuasive','professional','friendly','entertaining','inspirational','analytical','narrative')),
  internal_links integer not null default 3 check (internal_links between 0 and 10),
  table_of_contents boolean not null default true,
  call_to_action boolean not null default true,
  first_person boolean not null default false,
  mention_similar_products boolean not null default false,
  global_article_prompt text,
  global_keyword_prompt text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table workspace_output_settings enable row level security;

create policy "Output settings by agency" on workspace_output_settings
  for all using (
    workspace_id in (select id from workspaces where agency_id in (select user_agency_ids()))
  );

-- The calendar has held only articles. A planned keyword with no article yet is
-- an entry too, and it points at the keyword row rather than repeating the term.
alter table calendar_entries
  add column if not exists keyword_id uuid references keywords(id) on delete set null;

create index if not exists idx_calendar_entries_workspace_date
  on calendar_entries (workspace_id, scheduled_date);

-- `workspaces.language` is a locale code that every research call reads. The
-- wizard shows a label ("English", "Italian"), and writing the label here
-- instead of the code makes DataForSEO answer 40501 for that site and nothing
-- else: no error surfaces until a keyword run comes back empty. A local test
-- row read "English", so the class is real even though production is clean.
--
-- Normalise the obvious labels first, then refuse anything that is not a code.
update workspaces
   set language = case
     when language ilike 'english%' then 'en'
     when language ilike 'italian%' then 'it'
     when language ilike 'spanish%' then 'es'
     when language ilike 'french%' then 'fr'
     when language ilike 'german%' then 'de'
     when language ilike 'portuguese%' then 'pt'
     when language ilike 'dutch%' then 'nl'
     else lower(left(language, 2))
   end
 where language is not null
   and language !~ '^[a-z]{2}(-[a-z]{2})?$';

alter table workspaces drop constraint if exists workspaces_language_is_code;
alter table workspaces
  add constraint workspaces_language_is_code
  check (language ~ '^[a-z]{2}(-[a-z]{2})?$');

comment on constraint workspaces_language_is_code on workspaces is
  'A locale code, not a label. Labels belong in business_profile.language.';
