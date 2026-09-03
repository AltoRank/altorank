-- 043: what each outbound link answered when the draft was generated
-- Depends on: 001 (articles)
--
-- The brief tells the model to cite real URLs and nothing opened one. From
-- this migration the generator fetches every outbound link once, removes the
-- ones that are gone, and stores the answers here so the editor's audit tab
-- can say "3 of 4 sources answered" instead of "not verified". One row per
-- distinct URL: { url, status, ok, reason, removed, checkedAt }.
--
-- Nullable, and null means "never checked", which is true of every draft
-- before this and of anything written by hand. Not an empty array: a draft
-- with no outbound links at all stores [].

alter table articles add column if not exists link_checks jsonb;
