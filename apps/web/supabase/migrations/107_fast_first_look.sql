-- 107: a first look says where its time went, and owes its gate a body
-- Depends on: 076_onboarding_runs, 097_article_body_server_only, 106_run_budgets.
-- Apply BEFORE its code is deployed: see RUNBOOK.md. Without `owed_bodies`
-- a body that fails after its gate opened is not tried again (the draft
-- route cannot record that it is owed), and the reader's column is missing.
-- Old code never reads any of it, so applying early changes nothing.
--
-- A production first look (2026-10-09) took 7m15s from run start to done and
-- the only record of where the time went was provider_spend's timestamps:
-- nothing was billed for the first 96 seconds, so the site read, the crawl,
-- the speed test and the voice were one undivided silence.
--
-- `timings`   every stage of the run, in milliseconds since `started_at`:
--             {origin, stages: {<stage>: {startMs, endMs, busyMs, calls}},
--             marks: {gate, body_done, run_done}, entries: [...]}. Written by
--             the worker when its phases are done and merged by the draft
--             route when the body lands (apps/web/lib/onboarding/timings.ts).
--             Counts and milliseconds only: no term, no text.
alter table onboarding_runs add column if not exists timings jsonb;

comment on column onboarding_runs.timings is
  'Per-stage timing of a first look, ms since started_at: {origin, stages, marks, entries}. Instrumentation only; null on runs before 107.';

-- `articles.body_stream`   the first article's body as the writer streams it,
--             before it is processed and saved to `content`: what the gate's
--             reader shows while PRETRIAL_FULL_ARTICLE is on. Text of the
--             article, so a body column: like those 097 lists it is withheld
--             from `anon` and `authenticated` - a column added after 097 has
--             no client grant to begin with, and the revoke below says so
--             out loud - and read only by the server path that checks the
--             owner, the run's first article and the switch
--             (apps/web/app/api/onboard/first-article/route.ts). Cleared when
--             the body is saved or fails. With the switch off nothing writes
--             it. The code writes it only with the switch on and ignores a
--             failed write.
--
--             Written by the server only, too. 097 left INSERT and UPDATE on
--             the whole table, so a column revoke cannot take the write away;
--             a trigger refuses it instead: a member's own client (an editor
--             on the site, say) that sets it is refused, and the owner's
--             reader can never be handed markup a client wrote.
alter table articles add column if not exists body_stream text;
revoke select (body_stream) on public.articles from anon, authenticated;

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
  if (tg_op = 'INSERT' and new.body_stream is not null)
     or (tg_op = 'UPDATE' and new.body_stream is distinct from old.body_stream) then
    raise exception 'body_stream is written by the server only'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke execute on function public.articles_body_stream_server_only() from public, anon, authenticated;

drop trigger if exists articles_body_stream_server_only on public.articles;
create trigger articles_body_stream_server_only
  before insert or update of body_stream on public.articles
  for each row execute function public.articles_body_stream_server_only();

comment on column articles.body_stream is
  'The first article''s body as it is being written (PRETRIAL_FULL_ARTICLE). Server only, like the other body columns (097); null once the body is saved.';

-- `owed_bodies`   a first article whose outline the gate is showing and whose
--             body is still owed. Inserted by /api/internal/draft the moment
--             the gate opens on the outline; deleted when the body is saved,
--             or when it is given up. The body's retries and the nightly
--             sweep (apps/web/lib/content/owed-bodies.ts) read only this
--             table, never the article row: every column of `articles` is
--             writable by a member's client (097), so a status, a keyword or
--             an outline set there would otherwise buy a full draft every
--             night, on a topic the client chose, with no budget (round-1
--             review of this change).
--
--             `run_id`         the first look whose budget pays every try
--                              (106; null once the run is deleted)
--             `keyword`, `keyword_id`, `outline`  what the gate showed, as
--                              the server stored it
--             `attempts`       tries so far, the first included; the draft
--                              route claims each one here first
--             `allowance_usd`  the one top-up of the run's budget a body
--                              that failed after billing may get, once
--             `owed_since`, `last_tried_at`  the give-up clock and the
--                              quiet window between tries
--
-- Server only: RLS on and no policy, every client privilege revoked.
create table if not exists public.owed_bodies (
  article_id uuid primary key references public.articles(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid references public.onboarding_runs(id) on delete set null,
  keyword text not null,
  keyword_id uuid references public.keywords(id) on delete set null,
  outline jsonb not null,
  attempts integer not null default 1 check (attempts >= 0),
  allowance_usd numeric(10, 6) not null default 0 check (allowance_usd >= 0),
  owed_since timestamptz not null default now(),
  last_tried_at timestamptz not null default now()
);

create index if not exists idx_owed_bodies_last_tried on public.owed_bodies (last_tried_at);

comment on table public.owed_bodies is
  'First articles whose outline a first look''s gate is showing and whose body is still owed (migration 107). Server only; read by the draft route and the nightly owed sweep.';

alter table public.owed_bodies enable row level security;
revoke all on table public.owed_bodies from anon, authenticated;
grant select, insert, update, delete on table public.owed_bodies to service_role;
