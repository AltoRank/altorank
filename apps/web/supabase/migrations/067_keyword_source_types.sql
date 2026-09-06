-- 067: the research drawer's kinds become keyword sources
-- Depends on: 050_keyword_object (keywords.source_type), 054_keyword_research
--
-- Every keyword the research drawer inserted left `source_type` null, so the
-- dashboard's "Keyword sources" block could not attribute the highest-volume
-- insert path. The drawer now writes the input it knows (competitor domain,
-- audience, playbook id) and otherwise the research kind. 'chat', 'generate'
-- and 'import' are the kinds 050's list did not have; the constraint is
-- rebuilt the way 054 rebuilt `status`, so the list lives in one place.
alter table keywords drop constraint if exists keywords_source_type_check;

alter table keywords
  add constraint keywords_source_type_check
  check (source_type is null or source_type in
    ('competitor','audience','profile','gsc','manual','playbook','ranked','gap','ideas','ads',
     'chat','generate','import'));

comment on column keywords.source_type is
  'Where the term came from. competitor/audience/playbook carry the input in source_ref; chat/generate/manual/import name the research drawer path; profile/gsc/ranked/gap/ideas/ads are the analysis and selector paths.';
