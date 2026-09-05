-- Publishing behaviour per connection, and enough on the publish log to retry.

-- === workspace_integrations.publish_mode ===
--
-- 'draft'   the adapter creates the post unpublished on the CMS, for a person
--           to press Publish over there
-- 'publish' the post goes live the moment the adapter returns
--
-- Stored as a column rather than inside `config`, because config is the
-- encrypted credential blob: lib/crypto encrypts the named secret fields and
-- the row is otherwise opaque to a list query. The publish core, the editor
-- and the integrations page all need to read this without a key.
--
-- Two-step default on purpose. Existing connections have been publishing live
-- since they were made and nobody chose otherwise, so they are backfilled to
-- 'publish' and keep doing what they did. New connections default to 'draft',
-- the safe choice, and the connect dialog says so.
alter table workspace_integrations
  add column if not exists publish_mode text not null default 'publish'
    check (publish_mode in ('publish', 'draft'));

alter table workspace_integrations
  alter column publish_mode set default 'draft';

-- === publish_log: which connection, in which mode, and what it retried ===
--
-- A retry has to go back through the same destination the failed attempt
-- used. Until now the log only said that something failed, not where it was
-- going, so a retry on a workspace with two CMSs could pick the other one.
alter table publish_log
  add column if not exists destination_id uuid
    references workspace_integrations(id) on delete set null;

alter table publish_log
  add column if not exists publish_mode text
    check (publish_mode in ('publish', 'draft'));

-- The failed row this attempt is a retry of, so the audit trail reads as a
-- chain rather than as unrelated attempts.
alter table publish_log
  add column if not exists retry_of uuid
    references publish_log(id) on delete set null;

-- "The last publish_log entry for this article" is what decides whether a
-- Retry button appears, on every article row and in the editor.
create index if not exists publish_log_article
  on publish_log (article_id, created_at desc);
