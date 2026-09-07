-- 074: two cron runs must not write the same article twice
-- Depends on: 001_initial_schema (articles)
--
-- GET /api/cron/generate picks a keyword, then creates the article. Between
-- those two steps it holds nothing, so two invocations that overlap read the
-- same queue, pick the same keyword and both write. Measured on 2026-09-06:
-- two runs fired one second apart produced two complete 1,700-word drafts of
-- "blog post checklist" for the same workspace, inserted 13 ms apart. Two
-- model calls, two quota decrements, two "your draft is ready" emails, and
-- two near-identical articles in the client's review queue.
--
-- Overlap is not hypothetical. The route's own header says the four daily
-- runs come from two schedulers - Vercel keeps 07:00, .github/workflows/
-- generate-cron.yml calls the same endpoint at 01/13/19 UTC - and a run takes
-- about 100 seconds per article against a 300-second function that Vercel
-- will retry if it times out.
--
-- The window is one INSERT wide, so the database is the only place that can
-- close it. A partial unique index makes the second insert fail; the cron
-- reads that as "another run has this one" and moves on to the next
-- workspace rather than erroring.
--
-- Scoped to autonomous drafts on purpose. The editor's "Ask AI" regenerates
-- into an article that already exists (one row, updated, so no conflict) and
-- its rows are generated_autonomously = false, so a person writing by hand is
-- never blocked by a cron and never blocks one.
--
-- `drafting` is transient: generateArticle's failure path moves the row to
-- `error` (or back to its previous status). A row stuck here is a crashed run,
-- and it will hold its keyword until someone clears it - which is the same
-- thing it already does to the recommendation queue.
--
-- If this fails to create, two in-flight drafts already share a keyword:
--   select workspace_id, keyword, count(*) from articles
--   where status = 'drafting' and generated_autonomously
--   group by 1, 2 having count(*) > 1;
-- Those are duplicates from before this index. Delete the newer of each pair.
create unique index if not exists idx_articles_one_autonomous_draft_per_keyword
  on articles (workspace_id, keyword)
  where status = 'drafting' and generated_autonomously;

comment on index idx_articles_one_autonomous_draft_per_keyword is
  'One in-flight autonomous draft per keyword per workspace. Makes the second of two overlapping cron/generate runs fail its insert instead of writing a duplicate article.';
