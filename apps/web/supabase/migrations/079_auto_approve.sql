-- 079: auto-approve — publishing without the click, after a hold window
-- Depends on: 001_initial_schema (workspaces, articles), 003_publishing_schedule
--             (publishing_cadences: the clock this feeds)
--
-- A workspace may opt into publishing its drafts automatically: a draft that
-- has sat in review for `auto_approve_hold_hours` with nobody holding it, whose
-- fact check has no unsourced figure, whose audit has no failing item and whose
-- SEO score clears `auto_approve_min_seo`, is moved to the publish queue by the
-- publish cron. The gate in lib/publishing/core.ts is untouched: it still
-- requires an approval with `approved_by` set, and this adds a second,
-- attributable writer of that approval rather than a way around it.
--
-- `approved_by` on an automatic approval is `auto_approve_set_by`: the person
-- who turned the rule on. That is the accountability model — "approved
-- automatically under a rule set by X on <date>" — and it keeps the core
-- gate's `approved_by is not null` invariant true without touching the gate.
--
-- Defaults: off for every existing workspace (nothing changes behaviour on
-- deploy). Signup turns it on for the workspace it creates, because the person
-- typing one domain wants a blog that runs; an agency adding a client
-- workspace decides per client.
--
-- Idempotent: `add column if not exists`, `create index if not exists`,
-- `comment on` replaces.

alter table workspaces
  add column if not exists auto_approve boolean not null default false,
  add column if not exists auto_approve_hold_hours integer not null default 24,
  add column if not exists auto_approve_min_seo integer not null default 70,
  add column if not exists auto_approve_min_aeo integer,
  add column if not exists auto_approve_set_by uuid references auth.users(id) on delete set null,
  add column if not exists auto_approve_set_at timestamptz;

alter table workspaces
  drop constraint if exists workspaces_auto_approve_hold_hours_check,
  add constraint workspaces_auto_approve_hold_hours_check
    check (auto_approve_hold_hours between 0 and 168),
  drop constraint if exists workspaces_auto_approve_min_seo_check,
  add constraint workspaces_auto_approve_min_seo_check
    check (auto_approve_min_seo between 0 and 100),
  drop constraint if exists workspaces_auto_approve_min_aeo_check,
  add constraint workspaces_auto_approve_min_aeo_check
    check (auto_approve_min_aeo is null or auto_approve_min_aeo between 0 and 100);

comment on column workspaces.auto_approve is
  'Drafts publish without a click once the hold window passes and every hard check passes (lib/publishing/auto-approve.ts). Off = every draft waits for a person. Default false; signup sets true for the workspace it creates.';
comment on column workspaces.auto_approve_hold_hours is
  'Hours a draft sits in review before it may be approved automatically. 0-168, default 24. The publish cron runs once a day on Hobby, so the effective hold is this or the next run, whichever is later.';
comment on column workspaces.auto_approve_min_seo is
  'Lowest articles.seo_score an automatic approval accepts. 0-100, default 70. Below it the draft is held with the reason on the row.';
comment on column workspaces.auto_approve_min_aeo is
  'Lowest articles.aeo_score an automatic approval accepts. NULL = not required (the default while the score is being calibrated).';
comment on column workspaces.auto_approve_set_by is
  'Who turned auto-approve on. Written as approved_by on every automatic approval, so each publish is traceable to a named person''s rule. Must be a current member of the agency for the rule to fire.';

alter table articles
  add column if not exists approval_kind text,
  add column if not exists held_by uuid references auth.users(id) on delete set null,
  add column if not exists held_at timestamptz,
  add column if not exists auto_approve_after timestamptz,
  add column if not exists auto_approve_hold_reason text;

alter table articles
  drop constraint if exists articles_approval_kind_check,
  add constraint articles_approval_kind_check
    check (approval_kind is null or approval_kind in ('human', 'auto'));

comment on column articles.approval_kind is
  '''human'' when a person clicked Approve, ''auto'' when the publish cron approved it under the workspace rule. NULL before approval and on rows approved before 079.';
comment on column articles.held_by is
  'A person said "not this one": the automatic approval skips the draft until it is approved or archived by hand. Set by the Hold action and by any human edit to a draft awaiting automatic approval.';
comment on column articles.auto_approve_after is
  'When the hold window ends and the publish cron may approve this draft. Set at generation when the workspace has auto_approve on; NULL otherwise. Shown on the review card as "publishes after …".';
comment on column articles.auto_approve_hold_reason is
  'Why the last automatic-approval pass skipped this draft ("unsourced figure", "SEO score 61 below 70", "no active plan", …). Cleared when it is approved. Never silent: a held draft says why on its own row.';

create index if not exists idx_articles_auto_approve_due
  on articles (workspace_id, auto_approve_after)
  where status = 'review' and held_by is null and auto_approve_after is not null;
