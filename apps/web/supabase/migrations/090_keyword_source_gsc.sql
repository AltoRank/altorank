-- Search Console as a keyword source.
--
-- `source` records which discovery produced a term, strongest evidence first
-- (035, 036). 'ranked' meant "DataForSEO says we hold a position". Search
-- Console says the same thing from Google's own logs, sees sites the
-- DataForSEO index has not caught up with (altorank.co: 0 ranked rows, 26
-- Search Console queries), and until now had no way into this table at all -
-- lib/gsc/seed.ts is the way in.
alter table public.keywords drop constraint if exists keywords_source_check;

alter table public.keywords
  add constraint keywords_source_check
  check (source is null or source in ('ranked', 'gap', 'ideas', 'ads', 'gsc'));

comment on column public.keywords.source is
  'Which discovery call produced this term, strongest evidence first. ranked = DataForSEO reports we hold a SERP position. gsc = Search Console reports we appear for it. gap = a competitor holds one and we do not. ideas = seeded from our own headings or profile. ads = the domain-level Google Ads guess. NULL = stored before migration 035.';
