-- 108: the gate can show its first article being written without its text
-- Depends on: 097_article_body_server_only, 107_fast_first_look.
-- Apply BEFORE its code is deployed: see RUNBOOK.md. Old code never reads
-- or writes the column, so applying early changes nothing.
--
-- With PRETRIAL_FULL_ARTICLE off the gate shows the first article's outline
-- while its body is written behind it, and for two minutes nothing on the
-- page moved (recorded 2026-10-12). The owner should see the work happen -
-- which sections are written, how many words so far - and nothing of the
-- text itself.
--
-- `articles.body_progress`   counts only, written by /api/internal/draft
--             while the first article's body is written:
--             {v, stage: thinking | writing | finishing, since (ISO time the
--             stage began), sections (H2s the writer has started), words}.
--             No text: no heading, no term, no sentence. Read only by the
--             server path that checks the owner and the run's first article
--             (apps/web/app/api/onboard/first-article/progress/route.ts),
--             which turns `sections` into the indexes of the outline written
--             so far. Cleared when the body is saved or fails.
--
--             Kept from client tokens like `body_stream` (107): no select
--             grant - a column added after 097 has none to begin with, and
--             the revoke below says so - and no write, through the same
--             trigger, which now guards both columns: a member's client that
--             sets either is refused, so the owner's progress can only be
--             what the server measured.
alter table articles add column if not exists body_progress jsonb;
revoke select (body_progress) on public.articles from anon, authenticated;

comment on column articles.body_progress is
  'Counts-only progress of the first article''s body as it is written: {v, stage, since, sections, words}. Server only (108); null once the body is saved.';

-- caller: internal (trigger only - see the REVOKE below)
create or replace function public.articles_body_stream_server_only()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if pg_trigger_depth() = 0 then
    raise exception 'articles_body_stream_server_only is a trigger function'
      using errcode = '42501';
  end if;
  -- A client token: PostgREST runs it as `anon` or `authenticated`. The
  -- service role, psql and a foreign key's own action write as before.
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;
  if (tg_op = 'INSERT' and (new.body_stream is not null or new.body_progress is not null))
     or (tg_op = 'UPDATE' and (new.body_stream is distinct from old.body_stream
                               or new.body_progress is distinct from old.body_progress)) then
    raise exception 'body_stream and body_progress are written by the server only'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke execute on function public.articles_body_stream_server_only() from public, anon, authenticated;

drop trigger if exists articles_body_stream_server_only on public.articles;
create trigger articles_body_stream_server_only
  before insert or update of body_stream, body_progress on public.articles
  for each row execute function public.articles_body_stream_server_only();
