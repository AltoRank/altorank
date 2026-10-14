-- 105: a find on the customer's own site is a publish_log row, once
-- Depends on: 003_publishing_schedule (publish_log), 094_found_on_site.
-- Apply BEFORE MERGING the code that ships with it (a merge to main is the
-- deploy): cron/publish, the retry button and the found-on-site check filter
-- publish_log on `source`, and a query naming a column that does not exist
-- fails. cron/publish fails closed on that (it skips the cadence rather than
-- publishing), but nothing would publish on a schedule until this is applied.
--
-- 094 deliberately wrote no publish_log row for a find, because cron/publish
-- read any success as "this workspace already published today". So a find
-- reached nobody: no log, no email, no rank tracking. Now a find writes one row,
-- marked by `source`, and every reader that means "a push through a
-- connection" filters it out (cron/publish's daily check, the retry button's
-- last attempt, the check's own "did we push it before").
--
--   source  'push'           a publish attempt through a connection (every row
--                            before this migration, and every row the
--                            publishers write)
--           'found_on_site'  the nightly check found the article live on the
--                            customer's own site (lib/publishing/on-article-live.ts)
--   url     the page it was found on. Null for pushes, which carry their URL
--           on the article.
--
-- The partial unique index is the claim that makes the receipt happen once
-- per article and page: the row is inserted before the email is sent, and a
-- second insert for the same pair fails with 23505 and sends nothing.
--
-- No backfill. Articles already found before this ships keep no publish_log
-- row and never get one: the check only looks at articles whose
-- `found_on_site_at` is null, so they never transition again.
--
-- Rollback (deploy the previous code first: it names neither column):
--   drop index publish_log_found_on_site_once;
--   delete from publish_log where source = 'found_on_site';
--   alter table publish_log drop column url, drop column source;
-- The delete matters: old cron/publish code reads any success row as
-- "published today" and would skip that day's scheduled post.

alter table public.publish_log
  add column if not exists source text not null default 'push';

alter table public.publish_log
  drop constraint if exists publish_log_source_check,
  add constraint publish_log_source_check check (source in ('push', 'found_on_site'));

alter table public.publish_log
  add column if not exists url text;

alter table public.publish_log
  drop constraint if exists publish_log_found_url_check,
  add constraint publish_log_found_url_check check (source <> 'found_on_site' or url is not null);

create unique index if not exists publish_log_found_on_site_once
  on public.publish_log (article_id, url)
  where source = 'found_on_site';

comment on column public.publish_log.source is
  'push = a publish attempt through a connection; found_on_site = the nightly check found the article live on the customer''s own site. Readers that mean "a push" filter on push.';
comment on column public.publish_log.url is
  'For found_on_site rows: the page the article was found on. Unique per article (publish_log_found_on_site_once), which is what makes the receipt fire once.';
