-- 054: the keyword research surface
-- Depends on: 001_initial_schema (keywords, calendar_entries), 036_keyword_source_gap
--
-- Research produces more keywords than anyone schedules. Until now a term was
-- either untouched ('new', which is also what discovery writes by the
-- thousand) or on the calendar ('planned'), so a keyword a person looked at,
-- liked, and chose not to schedule yet had nowhere to go. 'stored' is that
-- shelf: researched, kept, not on the calendar.
--
-- The check constraint is rebuilt the way 036 rebuilt `source`, so the list of
-- allowed values lives in exactly one place.
ALTER TABLE keywords DROP CONSTRAINT IF EXISTS keywords_status_check;

ALTER TABLE keywords
  ADD CONSTRAINT keywords_status_check
  CHECK (status IN ('new', 'stored', 'planned', 'drafting', 'scheduled', 'shipped', 'error'));

COMMENT ON COLUMN keywords.status IS
  'new = discovered, nobody has looked. stored = researched and kept off the calendar on purpose. planned = on the calendar. drafting/scheduled/shipped/error follow the article.';

-- Every research run records its funnel. "Found 14, 3 had no search data, 2
-- too little volume, 5 scheduled" is the honest sentence the drawer shows
-- after a run, and it has to come from a row rather than from the client's
-- memory of what it just saw: a run that found nothing and a run that never
-- happened must be distinguishable a week later.
create table if not exists keyword_research_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind text not null check (kind in ('generate', 'playbook', 'chat', 'manual', 'import')),
  -- What was asked: source, competitors, audiences, playbook id, seeds, the
  -- typed term. Free-form because each kind asks a different question.
  input jsonb not null default '{}'::jsonb,
  found integer not null default 0,
  skipped_no_data integer not null default 0,
  skipped_low_volume integer not null default 0,
  -- Updated after the person clicks Schedule; a run proposes, it never schedules.
  scheduled integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_keyword_research_runs_workspace
  on keyword_research_runs (workspace_id, created_at desc);

alter table keyword_research_runs enable row level security;

drop policy if exists "Research runs by agency" on keyword_research_runs;
create policy "Research runs by agency" on keyword_research_runs
  for all using (
    workspace_id in (select id from workspaces where agency_id in (select user_agency_ids()))
  );

comment on table keyword_research_runs is
  'One row per research run from the Research keywords drawer (Generate, Playbooks, Add, Chat). Records the funnel so the count shown after a run is a fact, not a memory.';
