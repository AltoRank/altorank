-- The keyword as an object, not a row of numbers.
--
-- A keyword used to carry a term, a volume, a difficulty and an intent, and
-- the article written for it knew none of that except the term. Everything the
-- site owner could tell us about how they wanted a piece written - what shape
-- it should take, how long it should run, what they actually know first-hand -
-- had nowhere to live, so the writer never heard it and the reviewer could not
-- tell what the writer had been given.
--
-- Nothing here changes what publishes. Every column is either input to the
-- prompt or bookkeeping about where the keyword came from.

alter table keywords
  add column if not exists article_type text
    check (article_type is null or article_type in ('guide','listicle')),
  add column if not exists article_subtype text
    check (article_subtype is null or article_subtype in
      ('howTo','explainer','comparison','reference','roundup','resources','examples')),
  -- Word-count band. `auto` is the SERP-derived recommendation; the named bands
  -- are: short 1200-1600, medium 1600-2400, long 2400-3200, comprehensive 3200-4200.
  add column if not exists expected_length text not null default 'auto'
    check (expected_length in ('auto','short','medium','long','comprehensive')),
  -- Free text from the site owner, applied to this keyword's article only.
  add column if not exists instructions text,
  -- Array of {id, question, answer}. Questions are generated per keyword and
  -- ask for first-hand experience; answers are the owner's words and go into
  -- the article verbatim. Never fabricated: an empty array means nothing was
  -- generated yet, a null answer means nobody answered.
  add column if not exists quality_questions jsonb not null default '[]'::jsonb,
  -- Where the term came from, finer than `source`. `source` stays: the
  -- selector reads it and the check constraint on it predates this.
  add column if not exists source_type text
    check (source_type is null or source_type in
      ('competitor','audience','profile','gsc','manual','playbook','ranked','gap','ideas','ads')),
  -- The specific input behind source_type: a competitor domain, an audience
  -- string. Null when the type says everything ('manual', 'ranked').
  add column if not exists source_ref text,
  add column if not exists cpc numeric,
  -- Set when a person removed the keyword from the planner. The keyword stays
  -- tracked; the planner stops re-scheduling it.
  add column if not exists plan_excluded_at timestamptz;

comment on column keywords.quality_questions is
  'Array of {id, question, answer}; answers are first-hand statements from the site owner, quoted into the article.';
comment on column keywords.source_ref is
  'The input behind source_type: a competitor domain, an audience string. Null when the type is the whole story.';
comment on column keywords.plan_excluded_at is
  'When a person removed this keyword from the planner. The planner skips it; the keyword stays tracked.';

-- The article remembers the keyword it was written for and what it was told.
-- `instructions_snapshot` is what the writer saw at generation time, kept so
-- editing the keyword later does not rewrite the history of an existing draft.
alter table articles
  add column if not exists keyword_id uuid references keywords(id) on delete set null,
  add column if not exists article_type text
    check (article_type is null or article_type in ('guide','listicle')),
  add column if not exists article_subtype text
    check (article_subtype is null or article_subtype in
      ('howTo','explainer','comparison','reference','roundup','resources','examples')),
  add column if not exists expected_length text
    check (expected_length is null or expected_length in ('auto','short','medium','long','comprehensive')),
  add column if not exists instructions_snapshot jsonb;

create index if not exists idx_articles_keyword_id on articles (keyword_id);

-- Existing articles were matched to their keyword by text alone. Link the ones
-- where the term matches within the same workspace; anything ambiguous stays
-- null rather than guessed.
update articles a
set keyword_id = k.id
from keywords k
where a.keyword_id is null
  and a.keyword is not null
  and k.workspace_id = a.workspace_id
  and lower(k.term) = lower(a.keyword);
