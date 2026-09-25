# Migration runbook

How to take the production database from wherever it is to the current head of
`apps/web/supabase/migrations/`, one file at a time, with `psql`.

Migrations here are applied **by hand**, not by CI and not by the Supabase CLI.
There is no `schema_migrations` bookkeeping table: the pre-flight query below
works out what is applied by looking for one distinguishing object per file.

Verified 2026-09-05 against a fresh `supabase/postgres:15.8.1.060` container:
files 001–061 apply cleanly in numeric order (see
`docs/integration/MIGRATION-REPORT-2026-09-05.md` for the evidence and the
caveats). 062–078 have not been through that container check; they are in the
pre-flight query below and each is `if not exists` / `if exists` throughout, so
re-running one is safe — except 072, whose `create policy` statements are not
guarded (see its note below).

**Head is 085**, plus **091** (public tool usage), **093** (draft claims), **094** (found on site), **095** (site pages extract), **097** (article text server-only), **098** (fact check unchecked), **099** (trial gate server writes) and **100** (pre-trial spend bounds), each with its section at the end. **086–090 are not in this runbook**: they shipped without entries; check each by hand before applying 091, which does not depend on any of them. The one-line-per-file list in §3 and the pre-flight query in §1
both go to 085, then 091. **085 renames `agencies` → `accounts`** (and `agency_id`, `agency_members`, the RLS helpers); every pre-flight marker that named an old object now accepts either name, so the query reads correctly before and after it. **There is no 081**: it was left free for a track that never
shipped it, and a gap is not a missing file — do not go looking for one. **083 is not
listed here**: it shipped from another branch without a runbook entry; check it by
hand (`accounts.free_drafts_used`) before applying 084. (076
and 077 came from two tracks on the same day and are
independent of each other; either may be applied first. 078 stacks on the same
branch as 076 and does not depend on it.) If you add a
migration, add its marker to the query in the same
commit — the post-flight step is "every row is `t`", and a file with no row
passes that check by being absent from it.

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
  ('001_initial_schema',                     to_regclass('public.agencies') is not null or to_regclass('public.accounts') is not null),
  ('002_backend_additions',                  exists (select 1 from col where t='articles' and c='external_id')),
  ('003_publishing_schedule',                to_regclass('public.publishing_cadences') is not null),
  ('004_workspace_locale_and_integrations',  exists (select 1 from col where t='workspaces' and c='language')),
  ('005_featured_images',                    exists (select 1 from col where t='articles' and c='featured_image_url')),
  ('006_analytics_metrics',                  to_regclass('public.analytics_metrics') is not null),
  ('007_content_refresh',                    exists (select 1 from col where t='articles' and c='replaces_article_id')),
  ('008_backlink_exchange',                  to_regclass('public.backlink_exchanges') is not null),
  ('009_domain_audits',                      to_regclass('public.domain_audits') is not null),
  ('010_invites',                            to_regclass('public.invites') is not null),
  ('011_rls_backlinks_audits_invites',       exists (select 1 from pg_policy where polname in ('Exchanges visible to requester or provider agency','Exchanges visible to requester or provider account'))),
  ('012_tool_leads',                         to_regclass('public.tool_leads') is not null),
  ('013_approval_workflow',                  exists (select 1 from chk where conname='articles_status_check' and def like '%approved%')),
  ('014_billing',                            exists (select 1 from col where t in ('agencies','accounts') and c='plan_status')),
  ('015_article_research',                   exists (select 1 from col where t='articles' and c='research')),
  ('016_fix_agency_members_rls_recursion',   to_regprocedure('public.user_admin_agency_ids()') is not null or to_regprocedure('public.user_admin_account_ids()') is not null),
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
  ('031_workspace_domain_unique',            to_regclass('public.workspaces_agency_domain_unique') is not null or to_regclass('public.workspaces_account_domain_unique') is not null),
  ('032_backlink_detail',                    exists (select 1 from col where t='backlinks' and c='source_url')),
  ('033_agency_google',                      to_regclass('public.agency_integrations') is not null or to_regclass('public.account_integrations') is not null),
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
  ('058_agency_attribution',                 exists (select 1 from col where t in ('agencies','accounts') and c='attribution_source')),
  ('059_publish_mode_and_retry',             exists (select 1 from col where t='publish_log' and c='retry_of')),
  ('060_keyword_cpc',                        exists (select 1 from col where t='keywords' and c='cpc' and cm is not null)),
  ('061_workspace_pause_meta',               exists (select 1 from col where t='workspaces' and c='paused_meta')),
  ('062_workspace_scope_followups',          exists (select 1 from pg_policy where polname='Research runs by access')),
  ('064_output_toggles',                     exists (select 1 from col where t='workspace_output_settings' and c='infographics')),
  ('065_integration_tile_copy',              exists (select 1 from integrations where id='magento' and description like 'Static CMS pages%')),
  ('066_reports_bucket',                     exists (select 1 from storage.buckets where id='reports' and not public)),
  ('067_keyword_source_types',               exists (select 1 from chk where conname='keywords_source_type_check' and def like '%playbook%')),
  ('068_workspace_share_token',              exists (select 1 from col where t='workspaces' and c='share_token')),
  ('069_generate_idempotency',               to_regclass('public.agent_idempotency_keys') is not null),
  ('070_google_needs_reconnect',             exists (select 1 from col where t='workspace_integrations' and c='needs_reconnect')),
  ('071_billing_past_due',                   exists (select 1 from col where t in ('agencies','accounts') and c='payment_failed_at')),
  ('072_tenant_authz_hardening',             exists (select 1 from pg_trigger where tgname in ('agencies_guard_privileged_columns','accounts_guard_privileged_columns'))),
  ('073_lifecycle_emails',                   to_regclass('public.idx_invites_one_pending_per_email') is not null),
  ('074_one_autonomous_draft_per_keyword',   to_regclass('public.idx_articles_one_autonomous_draft_per_keyword') is not null),
  ('075_reports_one_per_period',             to_regclass('public.idx_reports_one_per_period') is not null),
  ('076_onboarding_runs',                    to_regclass('public.onboarding_runs') is not null),
  ('077_workspace_vocabulary_comments',      exists (select 1 from col where t='workspaces' and c='paused_meta' and cm like '%Pause this workspace%')),
  ('078_site_pages_tech_findings',           exists (select 1 from col where t='site_pages' and c='tech_findings')),
  ('079_auto_approve',                       exists (select 1 from col where t='workspaces' and c='auto_approve')),
  ('080_oauth_connectors',                   to_regclass('public.oauth_codes') is not null),
  ('082_system_events',                      to_regclass('public.system_events') is not null),
  ('084_analysis_attempts',                  exists (select 1 from col where t='workspaces' and c='analysis_attempts')),
  ('085_agencies_to_accounts',               to_regclass('public.accounts') is not null and to_regclass('public.agencies') is null),
  ('091_public_tool_usage',                  to_regclass('public.public_tool_usage') is not null and to_regprocedure('public.reserve_public_tool_spend(text,numeric,numeric)') is not null),
  ('093_draft_claims',                       exists (select 1 from col where t='calendar_entries' and c='draft_owed_at') and exists (select 1 from col where t='workspaces' and c='trial_resume_claimed_at')),
  ('097_article_body_server_only',           not has_column_privilege('authenticated', 'public.articles', 'content', 'SELECT')),
  ('095_site_pages_extract',                 exists (select 1 from col where t='site_pages' and c='extract')),
  ('094_found_on_site',                      to_regclass('public.found_on_site_checks') is not null and exists (select 1 from col where t='articles' and c='found_on_site_rejected') and exists (select 1 from col where t='workspaces' and c='found_on_site_unreadable')),
  ('098_fact_check_unchecked',               exists (select 1 from pg_constraint where conname = 'articles_fact_check_verdict_check' and pg_get_constraintdef(oid) like '%unchecked%')),
  ('099_trial_gate_server_writes',           not has_table_privilege('authenticated', 'public.api_keys', 'INSERT') and pg_get_functiondef('public.accounts_guard_privileged_columns'::regproc) like '%free_drafts_used%'),
  ('100_pre_trial_spend_bounds',             not has_table_privilege('authenticated', 'public.workspaces', 'INSERT') and exists (select 1 from pg_trigger where tgname = 'account_members_guard_own_row'))
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
- **`063` has no row and cannot have one.** It is a one-shot data backfill
  whose predicate is `created_at < now()`, so any workspace created *after* it
  ran and not yet onboarded looks identical to a database it never touched.
  There is nothing to detect. It is idempotent and cheap: if you are unsure,
  run it again.

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

### Production, from 048 to 078

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
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 064_output_toggles.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 065_integration_tile_copy.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 066_reports_bucket.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 067_keyword_source_types.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 068_workspace_share_token.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 069_generate_idempotency.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 070_google_needs_reconnect.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 071_billing_past_due.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 072_tenant_authz_hardening.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 073_lifecycle_emails.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 074_one_autonomous_draft_per_keyword.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 075_reports_one_per_period.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 076_onboarding_runs.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 077_workspace_vocabulary_comments.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 078_site_pages_tech_findings.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 079_auto_approve.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 080_oauth_connectors.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 082_system_events.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 084_analysis_attempts.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 085_agencies_to_accounts.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 091_public_tool_usage.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 093_draft_claims.sql   # BEFORE its code is merged; see its section
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 094_found_on_site.sql   # BEFORE its code is merged; see its section
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 095_site_pages_extract.sql   # BEFORE its code is merged; see its section
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 098_fact_check_unchecked.sql   # BEFORE its code is merged; see its section
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 097_article_body_server_only.sql   # AFTER its code is live; see its section
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 099_trial_gate_server_writes.sql   # AFTER its code is live; see its section
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f 100_pre_trial_spend_bounds.sql   # AFTER its code is live; see its section
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

Expected: exactly one row, `sent_emails` (073) — it carries a `workspace_id`
with RLS on and no policy **by design**, service-role only, the same shape as
`agent_idempotency_keys` (069). `public_checks`, `growth_plans`,
`admin_impersonations`, `agent_idempotency_keys` (069) and `email_preferences`
(073) are the same shape but have no `workspace_id`, so they do not appear.
Anything else in the result is a table with a real gap. Confirm a row is one of
ours (`grep -l <table> *.sql`) before acting on it: a **shared local stack**
carries tables no file here creates (on 2026-09-06, `webhook_deliveries`, which
no code in the repo references either).

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
| 076_onboarding_runs.sql | `onboarding/poll-run` (stacks on #146) | 001, **053** | yes | yes, loses run history |
| 077_workspace_vocabulary_comments.sql | `ui/workspace-vocabulary` (stacks on #146) | 001, 052, 053, 061 | yes | yes (old wording) |
| 078_site_pages_tech_findings.sql | `onboarding/site-crawl` (stacks on `onboarding/poll-run`) | **044**, 046 | yes | yes, loses findings only |
| 079_auto_approve.sql | `feat/auto-approve` | 001, 003 | yes | yes, loses hold stamps and approval kinds |
| 080_oauth_connectors.sql | `distribution/hosted-mcp` #158 | 001, **051** | yes | yes, disconnects connectors |
| 085_agencies_to_accounts.sql | `rename/agencies-to-accounts` | 001, 016, 053, 072 | yes (every step guarded) | by renaming back; nothing is dropped |
| 082_system_events.sql | `round5/observability` #172 | 001 | yes | yes, loses the event log only |
| 084_analysis_attempts.sql | `fix/reanalyse-and-cms-gate` | 001 | yes | yes, but the backfill's re-queue is not undone |
| 091_public_tool_usage.sql | `tools/public-api` | none | yes | yes, `drop function public.reserve_public_tool_spend(text,numeric,numeric); drop table public.public_tool_usage;` (paid public tools then refuse to run) |
| 093_draft_claims.sql | `fix/trial-hold-and-resume` | 001, 049 | yes | yes, drop the eight columns and the two indexes; the code that reads them must go first |
| 097_article_body_server_only.sql | `fix/trial-gate-first-article` | 001, 053; **its code deployed first** | yes | yes, `grant select on table public.articles to anon, authenticated;` (the text is then readable through the API again) |
| 095_site_pages_extract.sql | `fix/writer-site-facts` | **044**; **applied before its code merges** | yes | yes, after its code is reverted: `alter table site_pages drop column if exists extract;` (loses the stored extracts only) |
| 094_found_on_site.sql | `feat/published-elsewhere` | 001 | yes | yes, see its section (the check then fails loudly in the cron body, and the crawl still runs) |
| 098_fact_check_unchecked.sql | `fix/locale-contract` | 015 | yes | only once no row holds `unchecked`: re-add the three-value check |
| 099_trial_gate_server_writes.sql | `fix/trial-gate-first-article` | 083, 086, the `api_keys` table; **its code deployed first** | yes | yes, see its section (the three holes it closes reopen) |
| 100_pre_trial_spend_bounds.sql | `integration/root-causes-2026-09-25` | 076, 085, 053/072, 093; **its code deployed first** | yes | yes, see its section (the four holes it closes reopen) |

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
052/054/055 (the tables). Requires 053.

## 063 — added 2026-09-05

`063_onboarded_backfill.sql` (PR #94): `onboarded_at = created_at` for workspaces created before the wizard, so existing customers are not redirected to /onboarding after deploy. Idempotent; no schema change.

## 066 — added 2026-09-06

`066_reports_bucket.sql`: creates the private `reports` storage bucket (PDF only) that
`lib/reports/generate.ts` has always uploaded to, with select/insert/update/delete
policies on `storage.objects` keyed on the workspace folder segment via
`user_workspace_ids()`. If the bucket was created by hand as public, this flips it to
private: the app now mails and opens signed URLs, and `reports.url` holds the object
path rather than a public link (old rows are read either way). Requires 053. No data
change. Detect with `exists (select 1 from storage.buckets where id='reports' and not public)`.
## 064, 065, 067, 068, 069, 071 — added 2026-09-06

The six files that reached `main` without a note here. All six are
`if not exists` / `if exists` throughout and safe to re-run.

- **`064_output_toggles.sql`** — `workspace_output_settings` gains
  `infographics`, `video`, `emojis`, `faq_schema` (booleans) and `image_style`
  (text, default `'sketch'`). Read by `lib/content/enrich/index.ts` and written
  by the Article settings tab. Depends on 049. Roll back by dropping the five
  columns; the settings tab falls back to its defaults.
- **`065_integration_tile_copy.sql`** — data only: rewrites
  `integrations.description` for the CMS rows to match
  `apps/web/lib/cms/integration-descriptions.ts`, which is the source of truth
  and is tested against the adapters' payloads. **Change both together.** No
  rollback needed; re-running is the fix.
- **`067_keyword_source_types.sql`** — widens `keywords_source_type_check` to
  `competitor, audience, profile, gsc, manual, playbook, ranked, gap, ideas,
  ads, chat, generate, import` (or null). A superset of the old list, so it
  cannot fail on real data. Note `keywords.source` is a *different* column with
  a *narrower* CHECK (`ranked/gap/ideas/ads` or null): provenance goes in
  `source_type`.
- **`068_workspace_share_token.sql`** — `workspaces.share_token text`, the
  token behind `/share/[token]` and `/api/og/share/[token]`. Null means the
  site has never been shared. Roll back by dropping the column; every issued
  share link dies with it.
- **`069_generate_idempotency.sql`** — `agent_idempotency_keys
  (agency_id, key)` primary key, plus a created_at index. RLS on with **no
  policy**, deliberately: only the service role touches it
  (`lib/agent/idempotency.ts`). Roll back with `drop table
  agent_idempotency_keys;` — in-flight retries of `POST /articles/generate`
  become second drafts, nothing worse.
- **`071_billing_past_due.sql`** — `agencies.payment_failed_at timestamptz`
  and a widened `agencies_plan_status_check` that admits `past_due` and
  `unpaid`. Before restoring the old CHECK, move any row in those two states
  to `active` or `canceled` first, or the constraint will refuse to apply.

## 070 — added 2026-09-06

`070_google_needs_reconnect.sql`: adds `workspace_integrations.needs_reconnect boolean not null default false`
and `workspace_integrations.last_sync_error text`. The nightly analytics sync sets them when Google refuses
the stored refresh token (`invalid_grant` / 401); the OAuth callback clears them on reconnect; the settings
Search Console tab, the dashboard's Search Console blocks and the agent's `sync` block read them. Idempotent
(`add column if not exists`), no data change, depends on 001 only. Pre-flight:
`exists (select 1 from col where t='workspace_integrations' and c='needs_reconnect')`. Roll back with
`alter table workspace_integrations drop column needs_reconnect, drop column last_sync_error;`.

## 072 — added 2026-09-06

`072_tenant_authz_hardening.sql`: least privilege on the agency-scoped tables.
`api_keys` INSERT/UPDATE/DELETE and `invites` SELECT move to owner/admin
(`user_admin_agency_ids()`, from 053); the member-wide `backlink_credits`
INSERT policy is dropped (only the service role settles an exchange);
`workspaces` DELETE becomes admin-only; and a `BEFORE UPDATE` trigger on
`agencies` (`agencies_guard_privileged_columns`) raises `42501` when a
signed-in user (`auth.uid()` not null) changes `plan`, `plan_status`,
`stripe_*`, `current_period_end`, `cancels_at`, `payment_failed_at` or
`api_key`, and when a non-admin changes name/slug/branding/`report_email`.
**Consequence for the app:** every write to those billing columns must go
through `createServiceClient()` — the Stripe webhook already does, and
`app/actions/billing.ts` / `retention.ts` were moved to it in the same
integration branch. Depends on 053 (`user_admin_agency_ids`,
`user_can_access_workspace`) and 071 (`payment_failed_at`). No data change.
**Not safe to re-run**: the `create policy` statements have no `if not exists`,
so a second apply stops on `policy "API keys visible to agency members" …
already exists` (harmless under `-1`, nothing changes). Pre-flight:
`exists (select 1 from pg_trigger where tgname='agencies_guard_privileged_columns')`.
Roll back with `drop trigger agencies_guard_privileged_columns on agencies;
drop function agencies_guard_privileged_columns();` and re-create the 001/053
policies it dropped (`API keys by agency`, `Credits insert scoped to agency`,
`Invites visible to agency members`, `Workspaces deleted by access`).

## 073 — added 2026-09-06

`073_lifecycle_emails.sql`: adds `sent_emails` (a send is claimed here *before* it leaves,
keyed by type + subject + recipient, and the claim is released if the send fails, so a
retried Stripe webhook or a re-run cron cannot mail the same fact twice), `email_preferences`
(keyed by address rather than user id, because the monthly report may go to a shared inbox)
and a partial unique index giving one pending invite per address. Depends on 001 and 010.
Idempotent; the only data change is collapsing pre-existing duplicate pending invites.
Pre-flight: `to_regclass('public.idx_invites_one_pending_per_email') is not null` — the
index, not the table, because `sent_emails` and `email_preferences` already existed on the
local dev stack from an earlier hand-run and would report the file as applied before it was.
Roll back with `drop index idx_invites_one_pending_per_email; drop table sent_emails,
email_preferences;` — every lifecycle email becomes re-sendable and every opt-out is lost.
This file was `072_lifecycle_emails.sql` on its branch until 2026-09-07; it was renumbered
because 072 is the tenant hardening file above.

## 074 — added 2026-09-06

`074_one_autonomous_draft_per_keyword.sql`: partial unique index
`idx_articles_one_autonomous_draft_per_keyword` on `articles (workspace_id, keyword)`
where `status = 'drafting' and generated_autonomously`. The second of two overlapping
`cron/generate` runs fails its insert with `23505`, which `lib/content/generate.ts` maps to
`ConcurrentGenerationError` and the cron skips. Hand-written articles are
`generated_autonomously = false` and never collide. Depends on 001. Idempotent
(`create unique index if not exists`); fails to create only if two in-flight autonomous
drafts already share a keyword — the file's header has the query that finds them. Pre-flight:
`to_regclass('public.idx_articles_one_autonomous_draft_per_keyword') is not null`. Roll back
with `drop index idx_articles_one_autonomous_draft_per_keyword;`.

## 075 — added 2026-09-07

`075_reports_one_per_period.sql`: unique index `idx_reports_one_per_period` on
`reports (workspace_id, period)`. `lib/reports/generate.ts` has always upserted on
`onConflict: "workspace_id,period"`, and without this index PostgREST refuses every
upsert, so `cron/reports` never wrote a row. Depends on 001. Idempotent
(`create unique index if not exists`). Pre-flight:
`to_regclass('public.idx_reports_one_per_period') is not null`. Roll back with
`drop index idx_reports_one_per_period;`.

## 076 — added 2026-09-07

`076_onboarding_runs.sql`: table `onboarding_runs` (one row per onboarding run:
`status`, the progress screen's `phases` and `planned` as jsonb, `article_id`,
`error`, timestamps), partial unique index
`idx_onboarding_runs_one_running_per_workspace` (one `running` row per
workspace) and `idx_onboarding_runs_workspace_started`. RLS on, one `select`
policy for members (`user_workspace_ids()`, so it depends on **053**); every
write is service-role (`/api/onboard/start`, the `/api/onboard/run` worker,
`/api/internal/draft`). Replaces the SSE route `/api/onboard/stream`: the run
no longer lives inside the browser's request, so a reload or a closed tab no
longer stops it. Idempotent (`if not exists` throughout; the policy is
`drop … if exists` then `create`). Post-flight §4 step 2 does not list it: it
has a `workspace_id`, RLS on and a policy, so it does not appear. Pre-flight:
`to_regclass('public.onboarding_runs') is not null`. Roll back with
`drop table onboarding_runs;` (loses run history only; articles, keywords and
calendar entries are untouched).

## 077 — added 2026-09-07

`077_workspace_vocabulary_comments.sql`: four `comment on column` statements and
nothing else. `workspaces.auto_generate_weekly_limit`, `workspaces.paused_meta`,
`workspaces.refresh_days` and `invites.workspace_ids` each described the
*entity* as a "site", which POSITIONING.md settled as "workspace" on 2026-08-30.
The rest of the schema was already right: every scoped table carries
`workspace_id`, every account-scoped one `agency_id`, and `site_pages` is
correctly named because its rows are pages of the customer's real website.

No DDL, no rename, no data touched — only catalogue rows, so it takes no lock
worth naming and cannot fail on existing data. Depends on 001 (workspaces,
invites), 052 (`refresh_days`), 053 (`invites.workspace_ids`) and 061
(`paused_meta`); if any of those columns is missing, `comment on` errors and the
transaction rolls back, which is the intended signal. Idempotent (`comment on`
replaces). Pre-flight: `col_description` on `workspaces.paused_meta` contains
`Pause this workspace`. Roll back by re-applying the previous wording, which is
in this file's git history — there is nothing else to undo.

Numbering: 076 (`onboarding_runs`) and 077 came from two tracks on the same
day. Neither depends on the other; apply in numeric order as usual.

## 078 — added 2026-09-07

`078_site_pages_tech_findings.sql`: three columns on `site_pages`
(`tech_findings jsonb`, `tech_issue_count integer`, `tech_checked_at timestamptz`)
plus their comments and one partial index
`idx_site_pages_tech_issues (workspace_id, tech_issue_count desc) where tech_issue_count > 0`.

Onboarding now crawls the pages a customer already published and records what
is mechanically wrong with each one — status codes, tag lengths, H1 counts,
canonicals, robots directives, alt text, duplicates across the site. Free: a
plain GET and regular expressions, no model and no DataForSEO. Before this the
only thing that ever fetched those pages was `cron/site-pages`, gated on
`first_analysed_at` and one workspace a night, so on day one `site_pages` was
empty.

`tech_findings` NULL means nobody has checked the page; `[]` means checked and
clean. Keep the two distinguishable — collapsing them makes an unchecked site
render as a perfect one, which is the exact shape of CLAUDE.md rule 5.

No RLS change: 044's `"Site pages by agency"` policy is `for all` over the whole
row, so the new columns are covered. Depends on **044** (the table) and 046
(`page_type`, which the thin-content check reads). Idempotent
(`add column if not exists`, `create index if not exists`, `comment on`
replaces). Post-flight §4 step 2 does not list it: it adds no table. Pre-flight:
a `site_pages.tech_findings` column exists. Roll back with
`alter table site_pages drop column tech_findings, drop column tech_issue_count, drop column tech_checked_at;`
— the next crawl recomputes everything, so nothing is lost but the last run's
findings.

## 079 — added 2026-09-07

`079_auto_approve.sql`: six columns on `workspaces` (`auto_approve`,
`auto_approve_hold_hours`, `auto_approve_min_seo`, `auto_approve_min_aeo`,
`auto_approve_set_by`, `auto_approve_set_at`), five on `articles`
(`approval_kind`, `held_by`, `held_at`, `auto_approve_after`,
`auto_approve_hold_reason`), three check constraints, and one partial index
`idx_articles_auto_approve_due`.

A workspace may publish drafts without a click: after the hold window the
publish cron runs the checks the Approve button runs (plan, fact check, audit,
score floor) and moves the draft to the cadence queue with `approved_by` set to
whoever turned the rule on (`lib/publishing/auto-approve.ts`). The gate in
`lib/publishing/core.ts` is unchanged. Every existing workspace stays on manual
review (`auto_approve default false`); only signup sets it true for the
workspace it creates.

No RLS change: both tables' policies are `for all` over the row. Depends on 001
and 003. Idempotent throughout (`if not exists`, `drop constraint if exists` +
`add`, `comment on`). Post-flight §4 step 2 does not list it: no new table.
Pre-flight: `workspaces.auto_approve` exists. Roll back with
`alter table workspaces drop column auto_approve, drop column auto_approve_hold_hours, drop column auto_approve_min_seo, drop column auto_approve_min_aeo, drop column auto_approve_set_by, drop column auto_approve_set_at; alter table articles drop column approval_kind, drop column held_by, drop column held_at, drop column auto_approve_after, drop column auto_approve_hold_reason;`
— approvals already made stay approved (the status and `approved_by` columns
predate this file); only the record of *how* they were approved is lost.

## 080 — added 2026-09-07

`080_oauth_connectors.sql`: two tables, `oauth_clients` (dynamically registered
MCP clients: id, name, redirect_uris) and `oauth_codes` (one-shot authorization
codes with their PKCE challenge, scopes, agency and user), plus one nullable
column `api_keys.oauth_client_id`. The token an approved connector receives is
an `api_keys` row, so nothing else about authentication changes; this file only
records who minted a key and holds the ten-minute codes in flight.

RLS is enabled on both tables with **no policies**: the registration and token
endpoints run on the service role, and no user-facing query touches them.
Depends on 001 (`agencies`, `auth.users`) and **051** (`api_keys`); if 051 is
missing the `alter table api_keys` fails and the transaction rolls back.
Idempotent (`if not exists` throughout). Post-flight §4 step 2: both new tables
must show `rowsecurity = t`. Pre-flight: `to_regclass('public.oauth_codes')`.
Roll back with
`alter table api_keys drop column if exists oauth_client_id; drop table if exists oauth_codes; drop table if exists oauth_clients;`
— keys already issued to connectors keep working (they are ordinary rows); only
the record of which app holds them is lost, and no new connector can be
approved until the file is re-applied.

Numbering: 079 (`auto_approve`) landed on `main` while this file was in review
as 079; renamed to 080 before merge. Neither depends on the other.

## 082 — added 2026-09-07

`082_system_events.sql`: one new table, `system_events` (level, source,
message, nullable `agency_id`/`workspace_id`, `context jsonb`), four indexes,
no columns added anywhere else. It is the operational log written by
`lib/observability/record.ts` and read by `/admin/events` and the daily
operator digest.

RLS is enabled with **no policies**, the posture 069 and 080 use: every write
is the service role and the only reader is the operator page, which already
reads through the service client. A customer-facing `select` policy was
considered and left out — the rows carry raw provider error text, and the rule
to add when an account-level feed exists is
`agency_id in (select user_admin_agency_ids())` (owner/admin, per 072).

Depends only on **001** (`agencies`, `workspaces`); both foreign keys are
`on delete set null`, so deleting a workspace neither deletes nor blocks on the
record that it once failed. Idempotent (`if not exists` throughout, plus
`drop policy if exists`). Post-flight §4 step 2: the new table must show
`rowsecurity = t` and zero policies. Pre-flight:
`to_regclass('public.system_events')`.

Two check constraints are load-bearing and the recorder enforces the same
rules before it inserts: `level in ('info','warn','error')` and
`char_length(source) between 1 and 120`.

Numbering: this file is 082 and **081 does not exist**. It was written while
081 looked taken by a parallel track; that track did not ship a migration, and
renumbering after the branch was pushed would have been the riskier move —
another session picking 082 in the meantime is a collision, a gap is only a
gap. Nothing orders on the missing number and nothing waits for it.

**Nothing reads this table to make a decision**, so it is safe to prune and
safe to lose. There is no retention job yet; at eleven daily crons writing one
row each plus failures, expect a few thousand rows a year. When it needs one:
`delete from system_events where created_at < now() - interval '90 days';`

Roll back with `drop table if exists system_events;` — the code keeps working.
`recordEvent` treats a missing table as a failed insert, logs one line and
returns false, and `/admin/events` says the log is unavailable rather than
showing an empty table.

## 091 — public tool usage

`public_tool_usage` and `reserve_public_tool_spend(text, numeric, numeric)`,
for the paid public tools behind `POST /api/public/tools/<slug>`
(`lib/public-tools/spend.ts`). No dependencies; idempotent (`if not exists`,
`create or replace`). Post-flight §4 step 2 does not list it (no
`workspace_id`), but it is the same shape: RLS on, zero policies, service role
only.

**Until this is applied, every paid public tool answers `daily_cap`** — the
spend guard fails closed when the RPC errors. The six fetch-only tools do not
use it and work either way.

Smoke after applying (service role, then clean up):

```sql
select public.reserve_public_tool_spend('smoke-test', 0, 0);  -- t
select * from public.public_tool_usage where tool = 'smoke-test';
delete from public.public_tool_usage where tool = 'smoke-test';
```

## 093 — draft claims

Five nullable columns on `calendar_entries` (`draft_claimed_at`,
`draft_claimed_by`, `draft_failed_at`, `draft_failure`, `draft_owed_at`),
three on `workspaces` (`trial_resume_key`, `trial_resume_claimed_at`,
`trial_resumed_at`) and two partial indexes. Depends on 001 and 049
(`calendar_entries.keyword_id`); idempotent throughout (`if not exists`),
verified by applying it twice to the local stack.

**Apply before the code merges. This is a hard precondition, not a
nicety.** `main` auto-deploys on merge and migrations are applied by hand, so
the order is on whoever merges. If the code runs without these columns:

- **cron/generate drafts nothing for anybody, paying accounts included.** For
  every auto-generate site it counts the drafts in flight
  (`claimsInFlight`, lib/plan/draft-claim.ts) before its quota or due-entry
  reads, that count errors on the missing column and throws (an unknown is
  never a zero), and the per-site catch reports `error` for every site. Its
  first step, the unfinished-resume sweep, reports that it could not read
  them.
- **The calendar shows no planned entries at all**: lib/queries/calendar.ts
  selects `draft_failure`, the planned-entries read errors, and that read's
  error is not checked, so the calendar renders the written articles only.
- **Every checkout's Stripe webhook answers 500**: it writes
  `workspaces.trial_resume_key` inside the request and throws when it cannot,
  so Stripe retries the event (plan, status and pace are written before that
  point and are not lost) until the column exists.
- The trial resume claims nothing, and the draft route skips every resumed
  entry as not claimed.

Smoke after applying (read only):

```sql
select count(*) from calendar_entries where draft_claimed_at is not null;  -- 0 on day one
select count(*) from calendar_entries where draft_owed_at is not null;     -- 0 on day one
select count(*) from workspaces where trial_resume_key is not null;        -- 0 on day one
```

## 097 — article text server-only

Revokes table-level `SELECT` on `articles` from `anon` and `authenticated` and
grants back every column except the six that carry or quote the text:
`content`, `meta_description`, `fact_checks`, `link_checks`, `seo_checks`,
`aeo_checks`. `INSERT`/`UPDATE` and the service role are unchanged.
Idempotent (revoke, then grant whatever non-body columns exist now). Depends
on 001 and 053.

**Apply AFTER the code that ships with it is live on production, never
before.** The order is the reverse of 093. Code from before this migration
reads articles with `select("*")` through the signed-in person's client; with
097 applied that is `permission denied for table articles`, and the dashboard,
the editor, approve and publish error for every account. The new code reads
the text on the service role (`lib/articles/body-read.ts`) and works with or
without 097, so: merge, confirm the Vercel deploy of that commit is live (a
merge on a day the deploy cap is hit ships nothing), then apply.

Until it is applied, an account before its trial can still read its draft
straight from `/rest/v1/articles?select=content`: the app withholds the text,
the database does not.

Post-flight (expect `f`, `t`, `t`):

```sql
select has_column_privilege('authenticated', 'public.articles', 'content', 'SELECT'),
       has_column_privilege('authenticated', 'public.articles', 'title', 'SELECT'),
       has_column_privilege('service_role', 'public.articles', 'content', 'SELECT');
```

**A column added to `articles` later is not readable by a client token until
it is granted.** The migration that adds it must say
`grant select (<column>) on public.articles to anon, authenticated;` - unless
the column holds the article's text, in which case add it to the list in 097's
comment and to `ARTICLE_BODY_COLUMNS` instead. A missing grant fails loudly
(`permission denied`), never by leaking.

## 099 — trial gate server writes

Three writes and one read a signed-in person could make over PostgREST, each of
which undid the trial gate (`lib/billing/trial.ts`):

- `accounts.free_drafts_used` joins the columns `accounts_guard_privileged_columns`
  refuses to a signed-in user (the function from 086, one line added). It is
  the floor under the count the trial hold and the spend gate read; set to 0
  with the first article set to `error`, it read as "nothing written" and
  bought another paid draft.
- `api_keys`: `INSERT` and `UPDATE` revoked from `anon` and `authenticated`,
  `UPDATE (revoked_at)` granted back to `authenticated` (what Settings'
  Revoke writes). Keys are created by the server only (`createApiKey`, the
  OAuth code exchange). A client could insert a key it chose (the hash is a
  plain sha256) and name any user as `created_by`.
- `articles.research #- '{enrichment,faqSchema}'` on the rows that carry it:
  the stored FAQPage schema held the FAQ answers word for word, and `research`
  is readable by a client token. The writer no longer stores it; the
  publisher builds it from the text.

**Apply AFTER its code is live**, like 097. Code from before it writes
`free_drafts_used` and inserts API keys through the person's own client; with
099 applied, the counter write is refused (the live article count still
floors the allowance) and creating a key in Settings fails. The new code
writes both with the service role and works with or without 099.

Post-flight (expect `f`, `t`, `f`, `t`, `0`):

```sql
select has_table_privilege('authenticated', 'public.api_keys', 'INSERT'),
       has_column_privilege('authenticated', 'public.api_keys', 'revoked_at', 'UPDATE'),
       has_column_privilege('authenticated', 'public.api_keys', 'key_hash', 'UPDATE'),
       pg_get_functiondef('public.accounts_guard_privileged_columns'::regproc) like '%free_drafts_used%',
       (select count(*) from articles where research -> 'enrichment' ? 'faqSchema');
```

Rollback: re-run 086's `create or replace function` (drops the one line),
`grant insert, update on table public.api_keys to authenticated;`. The
stripped schemas are not restored; nothing read them.

## 100 — pre-trial spend bounds

The app now counts what an account before its trial ATTEMPTS: the one
pre-trial draft is claimed on `accounts.free_drafts_used` before anything is
bought, and setup runs are counted from `onboarding_runs`
(`lib/billing/trial-hold.ts`). This closes the four client-token writes that
could reset or multiply those counts:

- `onboarding_runs.workspace_id` becomes nullable and its foreign key
  `on delete set null` (was `cascade`), plus an index on `account_id`. A run
  outlives its site, so deleting a site and adding it again no longer hands
  back the account's setup runs.
- `workspaces`: `INSERT` revoked from `anon` and `authenticated`. Sites are
  inserted by the server (`lib/workspaces/insert.ts`, from createWorkspace and
  the Search Console import; signup already did). A client could insert any
  number of rows past the one-site allowance.
- `workspaces`: table `UPDATE` revoked from `anon` and `authenticated`, and
  granted back on every column except `id`, `account_id`, `ai_provider`,
  `ai_model` and `trial_resume_key` / `trial_resume_claimed_at` /
  `trial_resumed_at`. No code writes those through a person's client. A model
  name that does not exist made every draft fail after its research was
  bought.
- `account_members`: trigger `account_members_guard_own_row` refuses a
  signed-in user deleting their own membership or changing its `user_id` or
  `account_id`. With it gone, `ensureAccount` made them a fresh never-trialed
  account on the next page load. The server and cascades (no `auth.uid()`)
  pass.

**Apply AFTER its code is live**, like 097 and 099. Code from before it
inserts workspaces through the person's own client; with 100 applied, "Add
workspace" and the Search Console import fail for every account. The new code
writes the row with the service role and works with or without 100. Merge,
confirm the Vercel deploy of that commit is live, then apply.

Until it is applied, the holes stay open, and the app's counts still bound
most of them: a draft attempt is claimed either way, and setup runs are
counted either way (but a deleted site takes its runs with it).

**A column added to `workspaces` later is not writable by a client token
until it is granted.** Its migration must say
`grant update (<column>) on public.workspaces to authenticated;` unless only
the server writes it. A missing grant fails loudly (`permission denied`).

Post-flight (expect `t`, `t`, `f`, `f`, `t`, `t`):

```sql
select (select is_nullable from information_schema.columns
         where table_schema = 'public' and table_name = 'onboarding_runs' and column_name = 'workspace_id') = 'YES',
       (select confdeltype from pg_constraint where conname = 'onboarding_runs_workspace_id_fkey') = 'n',
       has_table_privilege('authenticated', 'public.workspaces', 'INSERT'),
       has_column_privilege('authenticated', 'public.workspaces', 'ai_model', 'UPDATE'),
       has_column_privilege('authenticated', 'public.workspaces', 'name', 'UPDATE'),
       exists (select 1 from pg_trigger where tgname = 'account_members_guard_own_row');
```

Verified 2026-09-25 on an isolated copy of the local schema, as
`authenticated` with an owner's JWT claims: before, `insert into workspaces`,
`update workspaces set ai_model = ...` and `delete from account_members` of
the caller's own row all succeeded; after, the first two are `permission
denied` and the third is refused by the trigger, while `update workspaces set
name = ...`, deleting another member and deleting a site all still work, and
the deleted site's run is kept with `workspace_id` null. Applied twice: the
second run is a no-op.

Rollback:
`drop trigger account_members_guard_own_row on public.account_members; drop function public.account_members_guard_own_row();`
`grant insert, update on table public.workspaces to authenticated;`
and, only once no run has a null `workspace_id`
(`delete from onboarding_runs where workspace_id is null;` loses the count),
`alter table public.onboarding_runs alter column workspace_id set not null;`
with the foreign key recreated `on delete cascade`.

## 095 — site pages extract

`095_site_pages_extract.sql`: one nullable `jsonb` column, `site_pages.extract`,
and new comments on the column and the table. It keeps what a business page
says about the business (its role - home, offering, work, about, contact,
pricing - its name, an index page's headings and named links, an about page's
opening text, and the founding, team and location statements the page makes),
read off the HTML the crawls already fetch (`lib/audit/site-extract.ts`). The
writer's site facts are built from it (`lib/content/site-facts.ts`), and a row
with an extract counts as a page the site has for the internal-link check
(`lib/linking/targets.ts`).

No RLS change: 053's `"Site pages by access"` policy is `for all` over the
whole row. Depends on **044** (the table). Idempotent
(`add column if not exists`, `comment on` replaces). Post-flight §4 step 2 does
not list it: it adds no table. Pre-flight: a `site_pages.extract` column
exists.

**Apply BEFORE the code that ships with it is merged.** The column is additive
and code from before it never names it, so applying first changes nothing. The
reverse breaks things the moment the deploy is live: the sitemap crawl's upsert
names `extract`, so every `site_pages` write fails (the onboarding pages phase
and the nightly `/api/cron/site-pages`); the writer's site-facts read errors,
and the writer is told the business's pages could not be read; and the
internal-link check's query errors, which it does not surface, so links to
crawled pages are stripped from drafts. So: apply, run the post-flight below,
then merge.

Existing rows stay NULL until a crawl reads the page again. The nightly
site-pages cron refills sitemap sites, one stale workspace per run; a site with
no sitemap is only reached by the first-look link crawl, which runs once per
workspace, so an existing workspace of that kind has no extract until it is
analysed again.

Post-flight (expect `jsonb`, then a count that is `0` right after applying and
grows as crawls run):

```sql
select data_type from information_schema.columns
 where table_schema = 'public' and table_name = 'site_pages' and column_name = 'extract';
select count(*) from site_pages where extract is not null;
```

Roll back only after the code is reverted:
`alter table site_pages drop column if exists extract;` — the writer then
knows only the profile again, which is how it was before.

## 094 — found on site

`094_found_on_site.sql`, for the nightly check that notices a draft published
on the customer's own site without going through AltoRank
(`lib/found-on-site/`, run from `cron/site-pages`). A real signup (2026-09-22)
published a draft on a site with no CMS connected and nothing recorded it.

- `articles`: `found_on_site_at`, `found_on_site_evidence` (jsonb),
  `found_on_site_prior` (jsonb), `found_on_site_rejected` (`text[] not null
  default '{}'`, a fast default, no rewrite). A find sets `status = 'live'`
  and `published_url` on the existing publish record; these columns say it
  was found rather than published by us, and hold what "Not my article"
  restores. `grant select` on the four to `anon, authenticated`: none is the
  article's text, and the calendar and "Not my article" read them through the
  person's own client. That keeps them readable whichever of 094 and **097**
  (article text server-only, `fix/trial-gate-first-article`) is applied
  first; 097 grants back only the columns that exist when it runs. Both
  orders were checked on the local stack inside rolled-back transactions.
- `workspaces.found_on_site_checked_at`: the check's turn order.
- `workspaces.found_on_site_unreadable`: why the check cannot see the site's
  new pages (`robots-unanswered`, `robots-disallowed`, `no-sitemap`,
  `empty-sitemap`, `javascript`; a check constraint holds the list), shown in
  the editor's Publish panel. Null = it can.
- `found_on_site_checks`: one row per page read, `(workspace_id, url)` primary
  key, with the page's main-content `words` (under 60 = a JavaScript shell).
  RLS on with **no policies**, the posture of 080 and 082: only the cron
  (service role) reads or writes it. Post-flight §4 step 2 lists it with zero
  policies; that is expected.

Depends only on **001**. Idempotent (`if not exists` throughout, and a
repeated `grant` is a no-op; applied twice in a row on the local stack,
2026-09-25). Nothing in the file backfills: no
article is marked found until the cron runs.

**Apply before the merge deploys.** `cron/site-pages` runs the check first; on
a database without these columns the check's first query fails, the body says
so (`found_on_site_error`, and a `job: "found-on-site"` result with status
`error`, which `system_events` records as a warning), and the crawl still runs.
The editor and the Articles list read the columns with `select *`, so they
degrade to "no find" rather than failing. These name the columns and fail
without them, which is why the order matters:

- the calendar (`lib/queries/planner-state.ts`) throws, so `/content` errors;
- the blog API (`/api/blog/v1/articles`, `altorank-next-blog`) answers 500;
- the free allowance's first-draft gate cannot read the drafts, and fails
  closed: cron/generate writes nothing on the free allowance and says why;
- the admin Users page shows no article counts.

Roll back with
`drop table if exists found_on_site_checks; alter table workspaces drop column if exists found_on_site_checked_at, drop column if exists found_on_site_unreadable; alter table articles drop column if exists found_on_site_at, drop column if exists found_on_site_evidence, drop column if exists found_on_site_prior, drop column if exists found_on_site_rejected;`
— run it only after putting any found article back first
(`update articles set status = found_on_site_prior->>'status', published_url = found_on_site_prior->>'published_url', published_at = (found_on_site_prior->>'published_at')::timestamptz where found_on_site_at is not null;`),
or those articles stay `live` at a URL nobody can then take back.

## 098 — fact-check `unchecked` verdict

Widens `articles_fact_check_verdict_check` to allow `'unchecked'`, the verdict
the fact checker returns for an article in a language the locale contract
(`lib/i18n/locale.ts`) does not describe. No dependencies beyond 015;
idempotent (`drop constraint if exists`, then add). Every existing row stays
valid.

**Apply before the code that writes it ships.** Until then, generating a draft
for a site whose language is not English, Italian, Spanish, French, German or
Turkish fails at the article save (the constraint refuses `unchecked`), where
before it saved a verdict read with English rules.

Smoke after applying:

```sql
select pg_get_constraintdef(oid) from pg_constraint
 where conname = 'articles_fact_check_verdict_check';  -- lists 'unchecked'
```
