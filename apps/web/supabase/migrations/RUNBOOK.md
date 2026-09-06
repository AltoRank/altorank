# Migration runbook

How to take the production database from wherever it is to the current head of
`apps/web/supabase/migrations/`, one file at a time, with `psql`.

Migrations here are applied **by hand**, not by CI and not by the Supabase CLI.
There is no `schema_migrations` bookkeeping table: the pre-flight query below
works out what is applied by looking for one distinguishing object per file.

Verified 2026-09-05 against a fresh `supabase/postgres:15.8.1.060` container:
files 001–061 apply cleanly in numeric order (see
`docs/integration/MIGRATION-REPORT-2026-09-05.md` for the evidence and the
caveats). Anything after 061 has not been through that check yet.

## Conventions

- `DATABASE_URL` is the direct Postgres connection string of the target project
  (the `postgres` role, port 5432 or the session pooler). Never paste it into a
  file in this repository.
- Every file is applied with `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f <file>`:
  - `-v ON_ERROR_STOP=1` aborts at the first failing statement instead of
    ploughing on.
  - `-1` wraps the whole file in one transaction, so a failure leaves nothing
    half-applied. None of the files use `CREATE INDEX CONCURRENTLY`, so this is
    safe for all of them.
- Run from the repository root; paths below are relative to it.
- Apply in numeric order and never skip a number. A few files depend on an
  earlier one from a different PR (listed under **Dependencies**), so a
  lower-numbered file whose PR has not merged yet blocks the higher one.
- Take a backup or a point-in-time-recovery marker before a batch. Several
  files are not reversible without data loss (see **Rollback notes**).

## 1. Pre-flight: what is already applied?

Paste this into `psql "$DATABASE_URL"`. It prints one row per migration file
with `t` (applied) or `f` (not applied). It assumes 001 is present, which is
true of every environment that has ever run the app; on a truly empty database
run 001 first.

```sql
with col as (
  select table_name t, column_name c, column_default d, is_nullable n,
         col_description((table_schema||'.'||table_name)::regclass, ordinal_position) cm
  from information_schema.columns where table_schema = 'public'
),
chk as (
  select conname, pg_get_constraintdef(oid) def from pg_constraint
),
m(file, applied) as (values
  ('001_initial_schema',                     to_regclass('public.agencies') is not null),
  ('002_backend_additions',                  exists (select 1 from col where t='articles' and c='external_id')),
  ('003_publishing_schedule',                to_regclass('public.publishing_cadences') is not null),
  ('004_workspace_locale_and_integrations',  exists (select 1 from col where t='workspaces' and c='language')),
  ('005_featured_images',                    exists (select 1 from col where t='articles' and c='featured_image_url')),
  ('006_analytics_metrics',                  to_regclass('public.analytics_metrics') is not null),
  ('007_content_refresh',                    exists (select 1 from col where t='articles' and c='replaces_article_id')),
  ('008_backlink_exchange',                  to_regclass('public.backlink_exchanges') is not null),
  ('009_domain_audits',                      to_regclass('public.domain_audits') is not null),
  ('010_invites',                            to_regclass('public.invites') is not null),
  ('011_rls_backlinks_audits_invites',       exists (select 1 from pg_policy where polname='Exchanges visible to requester or provider agency')),
  ('012_tool_leads',                         to_regclass('public.tool_leads') is not null),
  ('013_approval_workflow',                  exists (select 1 from chk where conname='articles_status_check' and def like '%approved%')),
  ('014_billing',                            exists (select 1 from col where t='agencies' and c='plan_status')),
  ('015_article_research',                   exists (select 1 from col where t='articles' and c='research')),
  ('016_fix_agency_members_rls_recursion',   to_regprocedure('public.user_admin_agency_ids()') is not null),
  ('017_autonomous_generation',              exists (select 1 from col where t='workspaces' and c='auto_generate')),
  ('018_domain_analysis',                    exists (select 1 from col where t='domain_audits' and c='readiness')),
  ('019_topical_profile',                    exists (select 1 from col where t='workspaces' and c='topical_profile')),
  ('020_ai_visibility',                      to_regclass('public.geo_prompts') is not null),
  ('021_ranked_keywords',                    exists (select 1 from col where t='domain_audits' and c='ranked_keywords')),
  ('022_article_selection_rationale',        exists (select 1 from col where t='articles' and c='selection_reasons')),
  ('023_unmeasured_dr_is_null',              exists (select 1 from col where t='workspaces' and c='dr' and d is null)),
  ('024_detected_platform',                  exists (select 1 from col where t='workspaces' and c='detected_platform')),
  ('025_provider_spend',                     to_regclass('public.provider_spend') is not null),
  ('026_unranked_is_null',                   exists (select 1 from col where t='keyword_rankings' and c='position' and n='YES')),
  ('027_citation_readiness',                 exists (select 1 from col where t='articles' and c='aeo_score')),
  ('028_indexnow_key',                       exists (select 1 from col where t='workspaces' and c='indexnow_key')),
  ('029_growth_plans',                       to_regclass('public.growth_plans') is not null),
  ('030_admin_impersonations',               to_regclass('public.admin_impersonations') is not null),
  ('031_workspace_domain_unique',            to_regclass('public.workspaces_agency_domain_unique') is not null),
  ('032_backlink_detail',                    exists (select 1 from col where t='backlinks' and c='source_url')),
  ('033_agency_google',                      to_regclass('public.agency_integrations') is not null),
  ('034_workspace_metrics',                  to_regclass('public.workspace_metrics') is not null),
  ('035_keyword_source',                     exists (select 1 from col where t='keywords' and c='source')),
  ('036_keyword_source_gap',                 exists (select 1 from chk where conname='keywords_source_check' and def like '%gap%')),
  ('037_bing_webmaster',                     exists (select 1 from chk where conname='analytics_metrics_source_check' and def like '%bing%')),
  ('038_analytics_metrics_rls',              (select relrowsecurity from pg_class where oid = to_regclass('public.analytics_metrics'))),
  ('039_exchange_content_credits',           exists (select 1 from chk where conname='backlink_credits_reason_check' and def like '%supply_article%')),
  ('040_git_integration',                    exists (select 1 from integrations where id='git')),
  ('041_generation_pace',                    exists (select 1 from chk where conname='workspaces_auto_generate_weekly_limit_check')),
  ('042_default_pace',                       exists (select 1 from col where t='workspaces' and c='auto_generate_weekly_limit' and d='7')),
  ('043_article_link_checks',                exists (select 1 from col where t='articles' and c='link_checks')),
  ('044_site_pages',                         to_regclass('public.site_pages') is not null),
  ('045_article_images_bucket',              exists (select 1 from storage.buckets where id='article-images')),
  ('046_site_pages_type',                    exists (select 1 from col where t='site_pages' and c='page_type')),
  ('047_site_pages_rendered',                exists (select 1 from col where t='site_pages' and c='rendered_by')),
  ('048_workspace_business_profile',         exists (select 1 from col where t='workspaces' and c='business_profile')),
  ('049_onboarding_plan (tables/columns)',   to_regclass('public.workspace_output_settings') is not null),
  ('049_onboarding_plan (language CHECK)',   exists (select 1 from chk where conname='workspaces_language_is_code')),
  ('050_keyword_object',                     exists (select 1 from col where t='keywords' and c='article_type')),
  ('051_api_keys',                           to_regclass('public.api_keys') is not null),
  ('052_refresh_engine',                     to_regclass('public.refresh_candidates') is not null),
  ('053_workspace_roles',                    to_regprocedure('public.user_workspace_ids()') is not null),
  ('054_keyword_research',                   to_regclass('public.keyword_research_runs') is not null),
  ('055_linking',                            to_regclass('public.link_sources') is not null),
  ('056_wordpress_plugin',                   exists (select 1 from chk where conname='publish_log_triggered_by_check' and def like '%webhook%')),
  ('057_public_checks',                      to_regclass('public.public_checks') is not null),
  ('058_agency_attribution',                 exists (select 1 from col where t='agencies' and c='attribution_source')),
  ('059_publish_mode_and_retry',             exists (select 1 from col where t='publish_log' and c='retry_of')),
  ('060_keyword_cpc',                        exists (select 1 from col where t='keywords' and c='cpc' and cm is not null)),
  ('061_workspace_pause_meta',               exists (select 1 from col where t='workspaces' and c='paused_meta'))
)
select file, applied from m order by file;
```

Notes on two markers:

- `049` has two rows because two versions of the file exist on open branches.
  The newer one (on `sup-onboarding-wizard`) adds the `workspaces_language_is_code`
  CHECK; the older one does not. If the first row is `t` and the second `f`,
  re-run the current `049_onboarding_plan.sql` — it is idempotent apart from
  the policy line, which 053 has by then replaced (see report).
- `060` is detected by the column *comment* on `keywords.cpc`, because 050
  also adds the column. `060` applied is what puts the comment there.

## 2. Pre-checks that can make a file fail on real data

Run these before the batch that contains the file. Empty result = safe.

**049 — `workspaces.language` must normalise to a locale code.**
The file rewrites labels ("English") to codes and then adds a CHECK. Any row
the rewrite cannot turn into `^[a-z]{2}(-[a-z]{2})?$` makes the `ADD CONSTRAINT`
fail and the whole file roll back.

```sql
select id, name, language from workspaces
where language !~ '^[a-z]{2}(-[a-z]{2})?$'
  and language !~* '^(english|italian|spanish|french|german|portuguese|dutch)'
  and lower(left(language, 2)) !~ '^[a-z]{2}$';
```

Fix offending rows by hand (`update workspaces set language = 'en' where id = ...`).

**054 — `keywords.status` values must all be in the new list.**
The new CHECK is a superset of the old one (adds `stored`), so this is a
formality:

```sql
select status, count(*) from keywords
where status not in ('new','stored','planned','drafting','scheduled','shipped','error')
group by 1;
```

**056 — `publish_log.triggered_by` values must all be in the new list.**
Also a superset (adds `webhook`):

```sql
select triggered_by, count(*) from publish_log
where triggered_by not in ('cron','manual','webhook') group by 1;
```

**053 — behaviour change, not a failure risk.** It replaces every
workspace-scoped `"... by agency"` policy with a `"... by access"` policy that
honours `agency_members.workspace_ids`. Existing members have `workspace_ids
= NULL` (all workspaces) after the file, so nobody loses access on apply.
Restricting a member is a later, explicit write to that column.

## 3. Apply

Set the target once:

```bash
export DATABASE_URL='postgresql://postgres:...@db.<project>.supabase.co:5432/postgres'
cd apps/web/supabase/migrations
```

### Fresh database (everything)

```bash
for f in 0*.sql; do
  echo "== $f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f "$f" || { echo "FAILED at $f"; break; }
done
```

`045_article_images_bucket.sql` needs the real Supabase storage schema
(`storage.buckets.public`, `file_size_limit`, `allowed_mime_types`). It works on
a hosted project and on `supabase start`; it fails on a bare
`supabase/postgres` Docker image, which only ships a stub `storage` schema.
That is the one file that could not be exercised in the 2026-09-05 check.

### Production, from 047 to 061

Only the files whose PR has merged to `main` exist in the checkout. Apply what
is there, in order. One line per file so a failure is attributable:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 048_workspace_business_profile.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 049_onboarding_plan.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 050_keyword_object.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 051_api_keys.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 052_refresh_engine.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 053_workspace_roles.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 054_keyword_research.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 055_linking.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 056_wordpress_plugin.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 057_public_checks.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 058_agency_attribution.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 059_publish_mode_and_retry.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 060_keyword_cpc.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 061_workspace_pause_meta.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 062_workspace_scope_followups.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 063_onboarded_backfill.sql
```

Re-running a file that is already applied is safe for 048, 049 (after 053),
050, 053, 056, 057, 058, 059, 060, 061. It is **not** safe for 051, 052, 054,
055 (and 049 before 053) — they error on an existing policy/table, and with
`-1` that error is harmless (nothing changes), but it will stop a loop. See the
report for the one-line fixes that would make them idempotent.

## 4. Post-flight

1. Run the pre-flight query again; every row should be `t`.
2. Every table with a `workspace_id` column has RLS on and at least one policy:

```sql
select c.relname, c.relrowsecurity,
       (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
  and exists (select 1 from pg_attribute a
              where a.attrelid = c.oid and a.attname = 'workspace_id' and not a.attisdropped)
  and (not c.relrowsecurity
       or not exists (select 1 from pg_policy p where p.polrelid = c.oid));
```

Expected: zero rows. (`public_checks`, `growth_plans`, `admin_impersonations`
have RLS on with zero policies by design — service-role only — and have no
`workspace_id`, so they do not appear.)

3. Smoke the app: sign in, open a workspace, open Settings, load the planner.

## 5. File → PR map and dependencies

| File | Branch / PR | Depends on | Idempotent | Reversible |
|---|---|---|---|---|
| 048_workspace_business_profile.sql | `sup-onboarding-wizard` #60 (also carried by #67 #72 #70 #79 #82 #84 #75 #77) | 001 | yes | yes |
| 049_onboarding_plan.sql | `sup-onboarding-wizard` #60 (newer variant also on #79 #82; older variant on #67 #72 #70 #75 #77 #84) | 001 | after 053 | mostly (see notes) |
| 050_keyword_object.sql | `sup-keyword-object` #67 (also #84) | 001 | yes | yes |
| 051_api_keys.sql | `sup-agent-surface` #68 | 001, `auth.users` | **no** | yes, loses issued keys |
| 052_refresh_engine.sql | `sup-refresh-engine` #73 | 044 | **no** | yes, loses refresh history |
| 053_workspace_roles.sql | `sup-settings-roles` #75 | **049**, 002, 003, 006, 009, 010, 020, 025, 034, 044 | yes | **no** (policy rewrite) |
| 054_keyword_research.sql | `sup-keyword-research` #72 | 001 | **no** | conditional |
| 055_linking.sql | `sup-linking` #70 | **049**, 044 | **no** | yes |
| 056_wordpress_plugin.sql | `sup-wordpress-plugin` #71 | 001, 003 | yes | conditional |
| 057_public_checks.sql | `sup-public-readiness` #69 | none | yes | yes |
| 058_agency_attribution.sql | `sup-attribution-question` #79 | 001 | yes | yes, loses answers |
| 059_publish_mode_and_retry.sql | `sup-publish-mode-retry` #83 | 001, 003 | yes | yes |
| 060_keyword_cpc.sql | `sup-traffic-value` #80 | 001 (050 optional) | yes | see notes |
| 061_workspace_pause_meta.sql | `sup-pace-cadence` #82 | 001 | yes | yes |

Bold dependencies cross PRs: **053 and 055 cannot be applied before 049.**
If #75 or #70 merges before #60, the merged tree still contains 049 (both
branches carry it), so numeric order handles it; just do not cherry-pick a
single file.

## 6. Rollback notes

Roll back the whole batch by restoring the backup if you can. Per-file notes
for when you cannot:

- **048** `alter table workspaces drop column business_profile;`
- **049** Schema is reversible (`drop table workspace_output_settings; alter
  table workspaces drop column sitemap_url, drop column blog_root_url, drop
  column example_article_urls, drop column onboarded_at, drop column
  onboarding_skipped_at, drop constraint workspaces_language_is_code; alter
  table calendar_entries drop column keyword_id; drop index
  idx_calendar_entries_workspace_date;`). The **data rewrite of
  `workspaces.language`** (labels → codes) is not reversible; the original
  labels are gone. That is intended — the app reads codes.
- **050** Drop the added columns on `keywords` and `articles`, plus
  `idx_articles_keyword_id`. The `articles.keyword_id` backfill lives in the
  dropped column, so it goes with it.
- **051** `drop table api_keys;` — every issued key is lost; agents holding
  them stop working. `agencies.api_key` is untouched (only its comment
  changed).
- **052** `drop table refresh_executions, refresh_tasks, refresh_candidates;
  alter table workspaces drop constraint workspaces_refresh_days_check, drop
  column refresh_enabled, drop column refresh_days, drop column
  refresh_last_analyzed_at;`
- **053** Not cleanly reversible. It drops the 001/002/003/006/009/020/025/
  034/038/044/049 `"... by agency"` policies and the 010 `"Agency members ..."`
  invite policies and creates `"... by access"` replacements. Rolling back
  means re-creating ~25 policies from the original files by hand while
  leaving the new functions in place (dropping `user_workspace_ids()` while
  a policy still references it fails). Treat 053 as forward-only; if the new
  policies misbehave, fix them forward. Columns (`agency_members.workspace_ids`,
  `invites.workspace_ids`, `workspaces.paused_until`, `agencies.cancels_at`)
  and `cancellation_feedback` drop normally.
- **054** Before restoring the old CHECK: `update keywords set status = 'new'
  where status = 'stored';` then `alter table keywords drop constraint
  keywords_status_check, add constraint keywords_status_check check (status
  in ('new','planned','drafting','scheduled','shipped','error'));` and `drop
  table keyword_research_runs;`
- **055** `drop table link_targets, link_sources;` — the seeded rows came
  from `workspaces.sitemap_url` / `blog_root_url`, which still hold them.
- **056** Restoring the two-value CHECK requires no `webhook` rows in
  `publish_log`. Deleting the `integrations` row `wordpress-plugin` **cascades**
  to every `workspace_integrations` row for it — every site connected through
  the plugin loses its connection. Leave the row.
- **057** `drop table public_checks;`
- **058** Drop the three `agencies.attribution_*` columns; answers are lost.
- **059** `alter table workspace_integrations alter column publish_mode set
  default 'publish';` then drop `publish_log.retry_of`, `publish_log.publish_mode`,
  `publish_log.destination_id`, index `publish_log_article`, and
  `workspace_integrations.publish_mode`.
- **060** Only the comment is 060's: `comment on column keywords.cpc is
  null;`. Do **not** drop `keywords.cpc` unless 050 is being rolled back too;
  050 declares the same column.
- **061** `alter table workspaces drop column paused_meta;`

## 062 — added 2026-09-05

`062_workspace_scope_followups.sql` (integration branch #91, review fix): drops the six
agency-scoped policies on `refresh_candidates`, `refresh_tasks`, `refresh_executions`,
`keyword_research_runs`, `link_sources`, `link_targets` and recreates them "by access" on
`user_workspace_ids()`. No data change. Requires 053 (defines `user_workspace_ids()`) and
052/054/055 (the tables). Apply last: **final production order is 048 → 062**.

## 063 — added 2026-09-05

`063_onboarded_backfill.sql` (PR #94): `onboarded_at = created_at` for workspaces created before the wizard, so existing customers are not redirected to /onboarding after deploy. Idempotent; no schema change. **Apply last: final production order is 048 → 063.**
