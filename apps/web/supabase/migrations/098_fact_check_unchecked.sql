-- 098: a fact-check verdict for "not checked", distinct from "nothing found"
-- Depends on: 015_article_research (articles.fact_check_verdict)
--
-- The fact checker reads figures and attributions with language rules, and
-- until 2026-09-25 it had only English ones: a Turkish draft (a real signup,
-- 2026-09-22) was read with English patterns, its "%20" and "Gartner'a göre"
-- unseen. The locale contract (lib/i18n/locale.ts) now describes each
-- language the checker reads, and a draft in any other language gets the
-- verdict `unchecked` instead of an English reading. `clean` would claim a
-- check that never happened; `review` would promise a list of claims that
-- does not exist. Auto-approve refuses `unchecked`; a person may approve it.
--
-- Additive: the constraint only widens, so every existing row stays valid and
-- the code that writes `unchecked` is the only new writer.

alter table public.articles drop constraint if exists articles_fact_check_verdict_check;

alter table public.articles
  add constraint articles_fact_check_verdict_check
  check (fact_check_verdict in ('clean', 'review', 'high_risk', 'unchecked'));

comment on column public.articles.fact_check_verdict is
  'FactCheckReport.verdict: clean = no unsourced figures found; review = claims to verify; high_risk = unsourced or contradicted figures (blocks approval); unchecked = the article''s language is not one the checker reads, so nothing was checked (blocks auto-approve only). NULL = generated before research existed.';
