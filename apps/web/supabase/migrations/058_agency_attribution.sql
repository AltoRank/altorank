-- 058: where the account heard of us, in the account's own words
-- Depends on: 001_initial_schema (agencies)
--
-- We sell visibility in AI answers and measure nothing about whether AI
-- answers send us anyone. The referrer cannot say: a person who reads about
-- us in a chat window and types the address in arrives as "direct", the same
-- as a bookmark. Asking is the only instrument that reaches that far, so the
-- wizard asks once, at the end, after the site is set up and the person has a
-- reason to answer.
--
-- On the account rather than the workspace: the question is about the person
-- who signed up, and a second site is not a second discovery. The keys repeat
-- lib/attribution.ts so a stray value cannot reach the column from anywhere
-- the validator does not run. `attribution_note` is the free text behind
-- "other" and stays null for every other source, so the column is not a
-- second answer to search.
--
-- No new policy: agencies already lets a member read and update their own
-- account row (001), and that is exactly the scope this needs.

alter table agencies
  add column if not exists attribution_source text
    check (attribution_source in ('google', 'ai', 'friend', 'linkedin', 'x', 'youtube', 'reddit', 'newsletter', 'podcast', 'other')),
  add column if not exists attribution_note text,
  add column if not exists attribution_answered_at timestamptz;

comment on column agencies.attribution_source is
  'Self-reported "how did you hear about us", asked once at the end of onboarding. Keys are ATTRIBUTION_SOURCES in lib/attribution.ts.';
comment on column agencies.attribution_note is
  'Free text behind attribution_source = other; null for every other source.';
comment on column agencies.attribution_answered_at is
  'When the answer was given or last corrected from Settings.';
