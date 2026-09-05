# Migration verification report — 2026-09-05

Scope: `apps/web/supabase/migrations/` 001–047 on `origin/main` plus every
migration file carried by the open `sup-*` branches (048–061). Goal: prove the
whole sequence applies cleanly in numeric order on a fresh Postgres, find
anything that is not idempotent, and check for CHECK/RLS conflicts between
files written on different branches.

Method and environment are at the end. Nothing here touched a shared database.

## Summary

- **61 files, one ordered set, applies cleanly.** Pass 1 on a fresh
  `supabase/postgres:15.8.1.060`: 60/61 OK. The one failure, 045, is an image
  artefact (stub `storage` schema), not a migration bug.
- **One file the brief did not list:** `061_workspace_pause_meta.sql` on
  `sup-pace-cadence` (#82). No duplicate numbers anywhere.
- **One content mismatch across duplicated files:** `049_onboarding_plan.sql`
  exists in two versions. The newer one (commit `4d15089`, on
  `sup-onboarding-wizard`, `sup-attribution-question`, `sup-pace-cadence`) is a
  strict superset — it adds the `workspaces.language` normalisation and the
  `workspaces_language_is_code` CHECK. The other six carriers have the older
  file. 048 and 050 are byte-identical everywhere.
- **Five files are not idempotent** (fail on a second run): 049 (only when
  run before 053), 051, 052, 054, 055. All are `create policy` without a
  preceding `drop policy if exists`, plus 051's unguarded table and index
  creation. Exact fixes below.
- **No CHECK conflicts.** `keywords.status` (054) and
  `publish_log.triggered_by` (056) each widen the base constraint and nothing
  else touches them. `keywords.cpc` is `add column if not exists ... numeric`
  in both 050 and 060; either order works.
- **RLS is complete.** Every table with a `workspace_id` has RLS enabled and
  at least one policy after 061. Six new tables still use the pre-053
  `user_agency_ids()` predicate; verified empirically that they are still
  narrowed correctly for a restricted member (details below), so this is a
  consistency nit, not a leak.

## 1. Inventory

Files >047 per branch (`git ls-tree origin/<branch> apps/web/supabase/migrations/`):

| Branch | PR | Files beyond 047 |
|---|---|---|
| sup-onboarding-wizard | #60 | 048, 049 (new) |
| sup-keyword-object | #67 | 048, 049 (old), 050 |
| sup-agent-surface | #68 | 051 |
| sup-refresh-engine | #73 | 052 |
| sup-settings-roles | #75 | 048, 049 (old), 053 |
| sup-keyword-research | #72 | 048, 049 (old), 054 |
| sup-linking | #70 | 048, 049 (old), 055 |
| sup-wordpress-plugin | #71 | 056 |
| sup-public-readiness | #69 | 057 |
| sup-attribution-question | #79 | 048, 049 (new), 058 |
| sup-publish-mode-retry | #83 | 059 |
| sup-traffic-value | #80 | 060 |
| sup-pace-cadence | #82 | 048, 049 (new), **061** (not in the brief) |
| sup-gsc-blocks | #84 | 048, 049 (old), 050 |
| sup-e2e-harness | #77 | 048, 049 (old) |
| sup-explainers-history | #85 | none |
| sup-editor-ai | #76 | none |
| sup-article-enrichment | #81 | none |

Files 001–047 are byte-identical to `origin/main` on every branch above
(checked with `cmp`). No branch modifies an earlier migration.

### Final ordered list

```
001_initial_schema.sql … 047_site_pages_rendered.sql   (origin/main, unchanged)
048_workspace_business_profile.sql   sup-onboarding-wizard  #60
049_onboarding_plan.sql              sup-onboarding-wizard  #60  (newer variant)
050_keyword_object.sql               sup-keyword-object     #67
051_api_keys.sql                     sup-agent-surface      #68
052_refresh_engine.sql               sup-refresh-engine     #73
053_workspace_roles.sql              sup-settings-roles     #75
054_keyword_research.sql             sup-keyword-research   #72
055_linking.sql                      sup-linking            #70
056_wordpress_plugin.sql             sup-wordpress-plugin   #71
057_public_checks.sql                sup-public-readiness   #69
058_agency_attribution.sql           sup-attribution-question #79
059_publish_mode_and_retry.sql       sup-publish-mode-retry #83
060_keyword_cpc.sql                  sup-traffic-value      #80
061_workspace_pause_meta.sql         sup-pace-cadence       #82
```

## 2. The 049 mismatch

Two md5s across nine carriers:

- `537f0028…` (newer, commit `4d15089` "migrations: language is a code, and the
  database now says so"): sup-onboarding-wizard, sup-attribution-question,
  sup-pace-cadence.
- `fbc1591e…` (older, commit `ba29ee0`): sup-e2e-harness, sup-gsc-blocks,
  sup-keyword-object, sup-keyword-research, sup-linking, sup-settings-roles.

`ba29ee0` is an ancestor of `4d15089`; the diff is purely additive (29 lines):
an `update workspaces set language = …` that maps labels to ISO codes, then
`drop constraint if exists` + `add constraint workspaces_language_is_code check
(language ~ '^[a-z]{2}(-[a-z]{2})?$')`.

Consequences:

- Whichever PR merges first decides which 049 lands on `main`. If an "old"
  carrier merges first and #60 later, git will show 049 as modified in #60's
  diff — that is expected, and re-running the file adds the CHECK. Re-running
  the newer 049 on a database that already ran the older one is idempotent
  **provided 053 has already replaced the `"Output settings by agency"`
  policy** (see idempotency), or if that one line is guarded.
- The wizard code on #60 writes codes (`resolveLocale("English") → "en"`), so
  the CHECK matches the app. Any pre-existing row holding a label or something
  the rewrite cannot reduce to two letters makes the file fail on real data.
  The runbook has the pre-check query.
- The pre-flight query in the runbook reports the two halves of 049
  separately so this state is visible.

## 3. Pass 1 — fresh database

`supabase/postgres:15.8.1.060`, PostgreSQL 15.8, `auth.users` and `auth.uid()`
present. Each file: `psql -v ON_ERROR_STOP=1 -1 -f`.

Result: **60 OK, 1 FAIL.**

```
FAIL 045_article_images_bucket.sql :: ERROR: column "public" of relation "buckets" does not exist
```

The image ships a stub `storage.buckets(id, name, owner, created_at,
updated_at)`; the real columns (`public`, `file_size_limit`,
`allowed_mime_types`) are created by the storage-api service's own migrations,
which run on hosted projects and under `supabase start`. Nothing after 045
depends on the bucket row or the `storage.objects` policy, so 046–061 were
exercised normally. 045 remains the one file this run could not prove.

## 4. Pass 2 — idempotency

The full sequence again on the same database. 37 OK, 24 FAIL. Failures split
into two groups.

### 4a. Pre-existing on `main` (001–047) — informational

001, 002, 003, 004, 005, 006, 007, 008, 009, 010, 011, 012, 015, 017, 018, 019,
020, 021, 033 (plus 045 for the image reason). These are unguarded table,
column, policy and index creations from the early schema. They have been in
production for months and the runbook never re-runs them; listed here so
nobody expects `for f in *.sql` to be re-runnable on a live database. Not
proposed for change.

### 4b. New files (048–061) — the actionable list

Only the first error per file is visible with `-1`; the static list below is
complete.

**049_onboarding_plan.sql** — line 44

```sql
create policy "Output settings by agency" on workspace_output_settings
```

Fix: insert before it
`drop policy if exists "Output settings by agency" on workspace_output_settings;`

Passed on pass 2 in this run only because 053 had already dropped that policy
and created `"Output settings by access"`. Standalone (049 re-run before 053)
it fails.

**051_api_keys.sql** — lines 13, 33, 42

- Line 13 creates the `api_keys` table without `if not exists`.
  Fix: `create table if not exists api_keys (`.
- Line 33: `create index api_keys_agency on api_keys (agency_id, created_at desc);`
  Fix: `create index if not exists api_keys_agency on api_keys (agency_id, created_at desc);`
- Line 36 `alter table api_keys enable row level security;` is fine as is
  (re-runnable).
- Line 42: `create policy "API keys by agency" on api_keys`
  Fix: insert `drop policy if exists "API keys by agency" on api_keys;` before it.

**052_refresh_engine.sql** — lines 120, 125, 130

```sql
create policy "Refresh candidates by agency" on refresh_candidates
create policy "Refresh tasks by agency" on refresh_tasks
create policy "Refresh executions by agency" on refresh_executions
```

Fix: insert before each
`drop policy if exists "Refresh candidates by agency" on refresh_candidates;`
`drop policy if exists "Refresh tasks by agency" on refresh_tasks;`
`drop policy if exists "Refresh executions by agency" on refresh_executions;`

**054_keyword_research.sql** — line 46

```sql
create policy "Research runs by agency" on keyword_research_runs
```

Fix: insert before it
`drop policy if exists "Research runs by agency" on keyword_research_runs;`

**055_linking.sql** — lines 63, 68

```sql
create policy "Link sources by agency" on link_sources
create policy "Link targets by agency" on link_targets
```

Fix: insert before each
`drop policy if exists "Link sources by agency" on link_sources;`
`drop policy if exists "Link targets by agency" on link_targets;`

Idempotent as written: 048, 050, 053 (every policy is preceded by `drop policy
if exists`), 056, 057, 058, 059, 060, 061.

## 5. Cross-checks

### CHECK constraints

| Column | Base | Changed by | Result | Conflict |
|---|---|---|---|---|
| `keywords.status` | 001: new, planned, drafting, scheduled, shipped, error | 054 drops `keywords_status_check` (the auto-generated name of 001's inline CHECK — confirmed by catalog) and re-adds with `stored` | superset | none; 050 does not touch `status` |
| `publish_log.triggered_by` | 003: cron, manual | 056 drops `publish_log_triggered_by_check`, re-adds with `webhook` | superset | none; 059 adds `publish_mode`, `destination_id`, `retry_of` only |
| `workspaces.language` | 004: `text not null default 'en'`, no CHECK | 049 (new variant) adds `workspaces_language_is_code` | new constraint | data-dependent, see pre-check |
| `workspaces.refresh_days` | — | 052 | new | none |
| `workspace_integrations.publish_mode` | — | 059 | new | none |
| `keywords.source_type` (050) vs `keyword_research_runs.kind` (054) | — | — | different columns | none |

`keywords.cpc`: 050 line `add column if not exists cpc numeric`, 060
`ADD COLUMN IF NOT EXISTS cpc numeric`. Same type, both guarded. 060 adds the
column comment; that comment is what the pre-flight uses to tell 060 from 050.

### RLS

Catalog after 061: all 24 tables with a `workspace_id` column have
`relrowsecurity = true` and exactly one policy. Tables with RLS on and zero
policies: `admin_impersonations` (030), `growth_plans` (029), `public_checks`
(057) — all service-role-only by design, none workspace-scoped.

Policies referencing `user_agency_ids()` on workspace-scoped tables after 053:

```
keyword_research_runs :: Research runs by agency        (054)
link_sources          :: Link sources by agency         (055)
link_targets          :: Link targets by agency         (055)
refresh_candidates    :: Refresh candidates by agency   (052)
refresh_executions    :: Refresh executions by agency   (052)
refresh_tasks         :: Refresh tasks by agency        (052)
```

These predate 053's `user_workspace_ids()` and use the older shape
`workspace_id in (select id from workspaces where agency_id in (select
user_agency_ids()))`. Because the inner `select id from workspaces` runs as the
caller and `workspaces` now has the 053 `"Workspaces by access"` policy, the
subquery is itself filtered to the member's allowed workspaces.

Verified, not assumed: inside a transaction, created one agency, two
workspaces, one `editor` member with `workspace_ids = {allowed}`, one row per
workspace in `refresh_candidates`, `keyword_research_runs`, `link_targets`;
then `set local role authenticated; set local request.jwt.claim.sub = <member>`.
Each table returned **1** row (the allowed workspace), `workspaces` returned 1.
So: no leak. Recommendation, not a blocker — switch the six policies to
`workspace_id in (select user_workspace_ids())` in a follow-up so the
narrowing is explicit rather than a side-effect of the `workspaces` policy.

Note also that 049's `"Output settings by agency"` policy is deliberately
replaced by 053 (`"Output settings by access"`), and 053 references
`workspace_output_settings`, so **053 requires 049**. 055 reads
`workspaces.sitemap_url` / `blog_root_url`, so **055 requires 049** too.
Both branches carry 048/049, so numeric order in a merged tree is enough;
cherry-picking a single file is not.

### Functions

After 061 the `public.user_*` helpers are: `user_agency_ids` (001/016),
`user_admin_agency_ids` (016), `user_workspace_ids`, `user_can_access_workspace`,
`user_full_access_agency_ids` (all 053). 053 uses `create or replace`
throughout.

## 6. Other observations

- **053 is forward-only.** It rewrites ~25 policies across 22 tables. Reversal
  means re-creating the originals by hand. Runbook says so.
- **056 rollback trap.** Deleting the `wordpress-plugin` integrations row
  cascades to `workspace_integrations`. Runbook says leave it.
- **059 default flip is deliberate**: adds `publish_mode` with default
  `'publish'` (so existing connections keep publishing), then sets the default
  to `'draft'` for new rows. Rollback restores the default; it does not need
  to touch existing rows.
- **057 `public_checks`** has RLS on and no policy, so only the service role
  can read or write it. That matches a server-side public checker; if the
  share page ever reads it with the anon key, it will need a `select` policy.
- `growth_plans` and `admin_impersonations` are in the same state and
  predate this batch.

## 7. Method

- Worktree `docs/migration-runbook` off `origin/main` at `3c4df5f`; no PR
  branch checked out or edited. Files gathered with
  `git show origin/<branch>:apps/web/supabase/migrations/<file>` into a scratch
  directory; duplicates compared with `md5` and `cmp`.
- Database: `docker run -d --name altorank-migcheck -e POSTGRES_PASSWORD=postgres
  -p 55432:5432 supabase/postgres:15.8.1.060`. Container removed after the run.
- Runner: one `psql "$DB" -v ON_ERROR_STOP=1 -q -1 -f <file>` per file, first
  `ERROR` line recorded, loop continues to the next file. Pass 1 then pass 2 on
  the same database.
- Cross-checks: `pg_class.relrowsecurity`, `pg_policy`, `pg_constraint` /
  `pg_get_constraintdef`, `information_schema.columns`, plus the RLS
  role-switch experiment described in section 5, all rolled back.
- Pre-flight query (runbook section 1) validated against the post-pass-1
  database: every row `t` except `045_article_images_bucket`.

## Addendum 2026-09-05 — 062

`062_workspace_scope_followups.sql` lands on the integration branch (#91) as a review fix: six policies from 052/054/055 move from `user_agency_ids()` to `user_workspace_ids()` (053). This resolves the consistency nit noted above. Not exercised in the fresh-DB run (it did not exist yet); it is policy-only and idempotent if written with `drop policy if exists`.

## Addendum — 063

`063_onboarded_backfill.sql` (PR #94) backfills `onboarded_at` for pre-existing workspaces. Without it the dashboard gate at `layout.tsx:107` sends every existing production workspace to /onboarding on first load. Idempotent; verified locally (UPDATE 2, then 0).
