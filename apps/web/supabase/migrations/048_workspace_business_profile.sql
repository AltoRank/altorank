-- The business profile the onboarding wizard proposes and the user verifies.
--
-- Kept as one jsonb rather than six columns because it is written and read as a
-- unit by one screen, and because the shape is still moving: audiences and
-- competitors started as strings and may grow yields per source.
--
-- `topical_profile` already exists and is a term-frequency map used for
-- relevance scoring. This is different: it is prose and lists a human confirmed,
-- and it is what the article prompts should describe the business as.
alter table workspaces add column if not exists business_profile jsonb;

comment on column workspaces.business_profile is
  'Onboarding profile: {name, language, country, description, audiences[], competitors[]}. Proposed by inferBusinessProfile from the site, then edited and confirmed by the user.';
