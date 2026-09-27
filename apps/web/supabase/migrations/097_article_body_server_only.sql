-- 097: an article's text answers the server, never a client token
-- Depends on: 001_initial_schema (articles), 053_workspace_roles (the
-- "Articles by access" policy). Nothing else.
--
-- The dashboard talks to PostgREST with the public anon key and the visitor's
-- session, and the session cookie is readable from the page. So whatever a
-- policy lets a member read, the member can read straight from /rest/v1,
-- whatever the app chooses to show. "Articles by access" lets every member
-- read every column of every article in their sites, which made the trial
-- gate's body lock an app-side filter on data the database had already
-- handed over: an account that had not started its trial could ask for
-- `select=content` and get the whole draft. A real signup (2026-09-22) copied
-- a draft off a preview page and published it on their own site within the
-- hour; this closes the other way to the same text.
--
-- Column privileges are the database's own "this column is not for you":
-- `anon` and `authenticated` keep SELECT on every article column except the
-- ones below, and those are read by the app on the service role only, after
-- the trial gate has answered (apps/web/lib/billing/body-lock.ts,
-- apps/web/lib/articles/body-read.ts). A client-token query that names one of
-- them - or `*`, which names all of them - fails with "permission denied for
-- table articles", which is also what a filter on one of them gets, so there
-- is no way to probe the text a row at a time either.
--
-- The list is ARTICLE_BODY_COLUMNS in apps/web/lib/articles/body-read.ts:
--
--   content            the text
--   meta_description   written by the model from it
--   fact_checks        each checked sentence, whole
--   link_checks        anchors lifted from it
--   seo_checks         notes that quote it
--   aeo_checks         notes that quote it
--
-- Writes are unchanged. INSERT and UPDATE stay granted on the whole table:
-- the editor saves through the person's own client, and a write hands nothing
-- back unless it asks to (`returning` a body column needs SELECT, and is
-- refused like any other read).
--
-- Why not a policy: row security decides rows, not columns. Why not the trial
-- gate in SQL: the gate reads the environment (whether billing is on, the
-- operator and bypass lists, the kill switch), so a SQL copy of it would be a
-- second answer to the same question, and the two would drift. The database
-- refuses the text to every client; the server decides who is handed it.
--
-- A column added to `articles` later is NOT readable by a client token until
-- it is granted. That is deliberate: grant it in the migration that adds it,
-- with `grant select (<column>) on public.articles to anon, authenticated;`,
-- unless it is text of the article, in which case add it to the list above
-- and to ARTICLE_BODY_COLUMNS instead.
--
-- Idempotent: revoke, then grant the current non-body columns. Rollback:
--   grant select on table public.articles to anon, authenticated;

revoke select on table public.articles from anon, authenticated;

do $$
declare
  readable text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into readable
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'articles'
     and column_name not in ('content', 'meta_description', 'fact_checks', 'link_checks', 'seo_checks', 'aeo_checks');
  execute format('grant select (%s) on table public.articles to anon, authenticated', readable);
end
$$;

-- The service role reads everything, as before; stated so a reader of this
-- file does not have to know the platform default.
grant select on table public.articles to service_role;
