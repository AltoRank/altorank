# Integration resolutions — `integration/outrank-port` (2026-09-05)

Twenty-two open PRs, built in parallel off `main` and conflicting pairwise, merged
into one branch with `git merge --no-ff` in leaf-first order. Every PR's head
commit is reachable from this branch, so GitHub closes them as merged when the
branch lands. Nothing was left out.

**Final state:** `npx vitest run` 146 files / **1385 tests** green (main had 80 / 815);
`npx tsc --noEmit` clean apart from the pre-existing `lib/cms/__tests__/adapters.test.ts`
`parentPageId` error; `npm run build` green after Tier 1, Tier 2 and at the end.
`workspace-scope-guard.test.ts` passes with **no new allowlist entries** — six tables
and four helpers were added to what it guards, and one stale allowance was removed.

**Order merged:** Tier 0 #56 #59 #65 #58 · Tier 1 #60 · Tier 2 #67 #72 #70 #79 #82 #84 #75 #77 ·
Tier 3 #68 #73 #71 #83 #76 #81 #78 #80 #85 · then `origin/main` (which had meanwhile
squash-merged #56 #58 #59 #65 and added #86 #88).

## Migrations

Final sequence in `apps/web/supabase/migrations/`: **048 049 050 051 052 053 054 055 056 058 059 060 061**.
057 is not in this branch: `057_public_checks.sql` belongs to `sup-public-readiness`,
which is not one of the 22. 061 (`workspace_pause_meta`, #82) was already renumbered by
its author to clear 059 (#83); nothing was renamed here.

- 048/049 appear on nine branches; every copy is byte-identical to #60's tip (049 is the
  newer version with the `workspaces_language_is_code` CHECK). 050 is identical on #67 and #84.
- Made re-runnable in this branch (fresh-DB dry run had them failing on a second pass):
  049, 051, 052, 054, 055 — `drop policy if exists` before each `create policy`,
  `if not exists` on 051's table and index. 048, 050, 053, 056–061 already were.
- Applied the whole sequence in order to local Docker (`supabase_db_altorank`) with
  `ON_ERROR_STOP=1`: all 13 exit 0 (only "already exists, skipping" notices).
- Dependencies: 053 and 055 need 049. 053 is forward-only (rewrites ~25 policies onto
  `user_workspace_ids()`). Six policies in 052/054/055 still use `user_agency_ids()`,
  narrowed through the `workspaces` RLS subquery — verified not a leak, left as is.
- `keywords.cpc` is `add column if not exists` in both 050 and 060; both files kept.

**Before deploy, a human applies 048 → 061 to production by hand, in that order.**

## Per-merge resolutions

## Tier 0
- #56 sup-integration-icons — clean.
- #59 sup-walkthrough-headers — clean.
- #65 sup-keyword-noise — clean.
- #58 claude/onpage-task-crawl — clean.

## Tier 1
- #60 sup-onboarding-wizard
  - `apps/web/lib/brand-icons.ts` (add/add): kept the union — #56's 15 marks plus #60's `git` entry. Additive icon table, no key collided.

## Tier 2
- #67 sup-keyword-object (874 tests, tsc clean)
  - `apps/web/app/(dashboard)/content/page.tsx`: kept #67's subtitle (month count, capacity "N of 60 scheduled", Plan/Top-up action) and re-inserted #59's scoped-domain span in place of the old "N workspaces" copy that both sides had removed. Both PRs' intent survives: honest scope label + capacity line.
- #72 sup-keyword-research (917 tests, tsc clean)
  - `apps/web/lib/onboarding/__tests__/plan.test.ts`: kept both new describe blocks (#67 `monthlyTarget`, #72 `nextOpenDates`/`SCHEDULE_CAP`); hoisted #72's mid-file import to the top. `lib/onboarding/plan.ts` itself auto-merged (both PRs append separate exports). Note: `PLAN_MAX_ENTRIES` (#67) and `SCHEDULE_CAP` (#72) are both 60 — two names for one cap, left as-is for a follow-up.
- #70 sup-linking (943 tests, tsc clean)
  - `apps/web/lib/queries/__tests__/workspace-scope-guard.test.ts`: union of the SCOPED_TABLES additions — `keyword_research_runs` (#72) plus `link_sources`, `link_targets` (#70). Adding a table to SCOPED_TABLES tightens the guard, it is not an allowlist entry. `generate.ts` auto-merged (`fetchLinkTargets(..., { keyword })` beside #67's brief).
- #79 sup-attribution-question (956 tests, tsc clean)
  - This branch carries #60's seven commits cherry-picked onto `main`, so every #60 file showed as add/add. Verified the cherry-picked copies are byte-identical to #60's tip, then:
  - `lib/ai/types.ts`, `lib/content/generate.ts`, `lib/onboarding/plan.ts`, `lib/onboarding/__tests__/plan.test.ts`: kept ours (HEAD already had #60 + #67/#72/#70 on top; #79 changes none of these itself).
  - `app/(setup)/onboarding/page.tsx`, `components/onboarding/wizard.tsx`, `lib/brand-icons.ts`: kept ours, then applied #79's own two-commit patch on top (sixth "About you" step, Skip-lands-on-the-question, six new brand marks → 22 icons). Applied clean.
  - `lib/queries/calendar.ts` (auto-merged wrongly): git appended the cherry-picked #60 "planned entries" block a second time. Restored the pre-merge version — #79 does not touch this file. The merge commit now touches exactly #79's own 12 files.
  - `lib/content/__tests__/generate-quota-caller.test.ts` timed out once at 5.5 s under load (the pre-existing flake noted in #76/#83); passes alone in 1.06 s.
- #82 sup-pace-cadence (988 tests, tsc clean)
  - `lib/onboarding/plan.ts` (the real design merge): one `schedulePlan(supabase, workspaceId, weeklyLimit, opts: PlanOptions)` where `PlanOptions = { from?, daysOfWeek? (#82), mode?: "replace" | "top-up" (#67) }`. `buildPlan` takes both `maxEntries` (#67) and `daysOfWeek` (#82) and lays entries out through #82's `planOffsets`. The candidate selection (#67: cap room, `plan_excluded_at`, taken ids/terms, top-up from the day after the last entry) moved into a shared `computePlan`, which `schedulePlan` writes and #82's `previewPlan` only describes — so "This moves 5, unplans 8" is computed from the same rows the write will produce (preview simulates the replace-mode delete). Kept `monthlyTarget`, `countScheduled`, `decoratePlannedKeywords` (#67), `diffPlan`, `describePlanDiff`, `readPlannedEntries` (#82), `nextOpenDates`/`scheduleKeywords` (#72). `PLAN_MAX_ENTRIES` stays 60 (#67); #82's base still had 30. Added `cadenceDays()` so top-ups also land on publishing days.
  - Callers moved to the new signature: `app/actions/plan.ts` `planMonth`, `app/api/cron/analyze/route.ts` top-up (both now pass `daysOfWeek: await cadenceDays(...)`). `lib/onboarding/pipeline.ts` and `app/actions/workspaces.ts` needed no change.
  - `app/actions/plan.ts` (add/add): both files kept whole — #67's keyword-brief/questions/remove/move/planMonth actions followed by #82's `getArticlesPlanState`/`previewArticlesPlan`/`applyArticlesPlan`; imports merged.
  - `components/dashboard/calendar-controls.tsx`: kept #82's `PausedBanner` + `ArticlesPlanPopover` and #59's "All" chip + comment and #72's `ResearchButtons`.
  - `lib/onboarding/__tests__/plan.test.ts`: all four describe blocks kept. One assertion changed: #82's "stays within the horizon and the entry cap" expected `PLAN_MAX_ENTRIES` entries at 7/week over 30 days, which was 30 on its base; with the cap at 60 the horizon binds, so it now expects `min(PLAN_MAX_ENTRIES, PLAN_HORIZON_DAYS)` (= 30, same number as before).
  - `lib/content/__tests__/generate-quota-caller.test.ts`: describe-level `timeout: 20_000`. generate.ts's import graph grew across #60/#67/#70/#77 and the first test in this file was timing out at 5 s under the full parallel run (passes alone in ~1 s). Not a behaviour change.
  - Separate commit: `049`, `054`, `055` gained `drop policy if exists` before each `create policy` (fresh-DB dry run finding).
- #84 sup-gsc-blocks (1021 tests, tsc clean)
  - `app/(dashboard)/keywords/page.tsx`: import union — #84's rankings/GSC imports plus #59's `DotSep`.
  - `components/dashboard/editor/article-editor.tsx`: import union — #70's `InternalLinksPanel` plus #84's `IndexingStatus`/`inspectionFrom`. Body hunks auto-merged.
  - `lib/queries/traffic.ts` is deleted by #84 (replaced by `lib/gsc/queries.ts`); nothing on HEAD still imported it.
- #75 sup-settings-roles (1056 tests, tsc clean)
  - `lib/queries/traffic.ts` + `__tests__/traffic.test.ts` (modify/delete): kept the deletion from #84. #75's only change there was `TrafficSeries.previousMeasured`, which #84's replacement `lib/gsc/analysis.ts › searchPerformance` already carries (and tests). The honest-states intent survives in the new module.
  - `app/(dashboard)/dashboard/page.tsx`: kept #84's `SearchPerformanceBlock` in place of the old `TrafficChart` (which #75 had patched — superseded); added #75's share card (`shareFacts` in the Promise.all, `<ShareResults>` in the header, already auto-merged); legend now uses #75's rule — the "Previous Nd" swatch only when `previousMeasured`, else "Previous period not synced yet" — with #84's wording.
  - `app/(dashboard)/settings/page.tsx`: took #75's `SettingsShell` + `BusinessForm` layout and placed #79's `AttributionCard` between the account form and the Password card.
  - `app/(setup)/onboarding/page.tsx`: kept #79's `account`/`answered` read and #75's `outputFromRow(output)`.
  - `components/onboarding/wizard.tsx`: import union — #79's `saveAttribution`/`AttributionPicker` plus #75's extracted settings forms (`BusinessFields`, `AudienceList`, `SiteFields`, `OutputFields`, `EMPTY_PROFILE`); body hunks auto-merged, tsc clean.
  - `lib/types.ts`: union — `Agency` gets #79's `attribution_*` and #75's `cancels_at`; `Workspace` gets #82's `paused_meta` and #75's `paused_until` (different columns, different meanings, both documented inline).
- #77 sup-e2e-harness (1056 tests, tsc clean on app code — see note)
  - `lib/content/generate.ts`: import union (#67 taxonomy/questions + #77 `e2eStubsEnabled`/`stubGenerateArticle`); the `E2E_STUBS` early return sits above #67's destructure, which keeps `keywordId`.
  - Note: `@playwright/test` is a new devDependency; the shared local `node_modules` did not have it, so `tsc` reported unresolved imports in `e2e/*` until it was installed locally (overlay, not committed). CI runs `npm ci` and is unaffected.

## Tier 3
- #68 sup-agent-surface (1085 tests, tsc clean)
  - `lib/content/generate.ts`: kept HEAD's output-prefs + keyword-row block (#60/#67) and replaced the inline slug expression with #68's exported `slugFor(title || keyword)`, which the agent API shares.
  - `app/(dashboard)/settings/settings-tabs.tsx` auto-merged: #75's six wizard tabs + #68's "API keys".
  - Separate commit: `051_api_keys.sql` made re-runnable (`if not exists` on table/index, `drop policy if exists`).
- #73 sup-refresh-engine (1132 tests, tsc clean)
  - `lib/ai/types.ts`: `ArticlePrompt` now carries `output` (#60), `brief` (#67) and `refreshOf` (#73); `ArticleBrief`, `OutputPrefs`, `RefreshContext` all kept.
  - `lib/ai/prompts.ts` Length section, one expression in precedence order: a rewrite gets #73's "stay between 70% and 130% of the current length"; otherwise the owner's length band (#67) when set and no explicit target; otherwise the SERP-derived target. #67's "WHAT THE SITE OWNER TOLD US" and #73's `buildRefreshSection`/`BANNED_PHRASES`/`buildUserMessage` untouched.
  - `lib/content/generate.ts`: imports union; both `slugFor` (#68) and `RefreshArticleResult` + the two overloads (#73) kept; the `E2E_STUBS` early return (#77) stays first, the destructure has both `keywordId` (#67) and `refreshOf` (#73); `fetchLinkTargets(supabase, workspaceId, article.id ?? undefined, { keyword })` combines #73's nullable id with #70's keyword ranking; `streamArticle` receives `output`, `brief` and `refreshOf`. #67's keyword-row/brief block runs on the refresh path too (harmless: a rewrite of a page we wrote still has a keyword row) — nothing is written to `articles` on that path.
  - `lib/e2e/stubs.ts` (not a conflict, a type break): `stubGenerateArticle` now returns the five fields #73 added to `GenerateArticleResult` (`html`, `metaDescription: ""`, `linkChecks: null`, `seoScore: 0`, `aeoScore: 0`).
  - `app/(dashboard)/settings/settings-tabs.tsx`: union — "API keys" (#68) and "Improvements" (#73) after #75's tabs.
  - Separate commit: `052_refresh_engine.sql` policies made re-runnable.
- #71 sup-wordpress-plugin (1169 tests, tsc clean)
  - `lib/cms/types.ts`: `CMSAdapter` keeps #73's documented optional `update()` plus #71's optional `listPosts()`; #71's `DeliveryAttempt`/`AdapterContext` (webhook retry reporting) and #73's `canUpdate()` guard both kept.
  - `lib/cms/webhook.ts`: took #71's rewritten adapter (documented contract, `event: publish_articles | update_article | unpublish_article | test`, three attempts with backoff, per-attempt `publish_log` rows). It already implements `update()` with the same signature #73 added, so #73's older `action: "update"` envelope was dropped in favour of the contract. The refresh engine only needs `canUpdate(adapter)` to be true, which it is.
  - `lib/cms/wordpress.ts`: took #71's `update()` (PUT, `jsonHeaders()`, `postBody()` with media sideload + SEO meta) over #73's minimal title/content/excerpt POST — superset.
- #83 sup-publish-mode-retry (1207 tests, tsc clean)
  - `lib/publishing/core.ts`: #83's structure (`PublishContext`, `PublishError`, `pushToDestination`, update-instead-of-create, `published_url: result.url || null`, draft skips IndexNow/exchange) with #71's additions inside it: `resolveCMSAdapter(config, { onDelivery })` per-attempt `publish_log` rows, `siteUrl` from the workspace domain, the payload's `id`/`markdown`/`focusKeyword`/`createdAt`, and the plugin's `result.status === "draft"` → `held-in-cms` indexing status. `ArticleRow` gained `keyword`, `created_at`, `published_at` for the Markdown rendering. Both "draft" paths kept: the connection's mode (#83) and the plugin's server-side setting (#71).
  - `lib/cms/webhook.ts`: #71's contract adapter kept; #83's `publishMode` now rides at the top level of the `publish_articles` and `update_article` envelopes (`article.publishMode ?? "publish"`), and the contract comment says so. #71's contract test updated for the new field; #83's "passes publishMode in the envelope" test passes unchanged.
  - `lib/cms/wordpress.ts`: #71's `postBody(article, status)` is now called with `article.publishMode === "draft" ? "draft" : "publish"` in both `publish()` and `update()` (#83's rule, #71's body).
  - `lib/cms/wordpress-plugin.ts` (not a conflict, a semantic gap): the plugin adapter sent `status: "publish"` unconditionally; it now honours `publishMode` the same way. `lib/cms/publish-mode.ts` `DRAFT_BEHAVIOUR` gained the `wordpress-plugin` entry the `Record<CMSConfig["type"], string>` type demands.
  - `lib/types.ts` `PublishLogEntry`: `triggered_by` keeps #71's `"webhook"`; #83's `destination_id`, `publish_mode`, `retry_of` added.
  - `app/(dashboard)/content/[id]/page.tsx`: Promise.all carries #70's `outputRow` and #83's `lastPublish`; `fetchLinkTargets(..., { keyword })` kept; editor gets `linkTargets`, `internalLinksWanted` and `lastPublish`.
  - `app/api/cron/publish/route.ts`: import union (#82 `withoutPaused`, #83 `PublishError`/`recordPublish`).
  - `components/dashboard/editor/article-editor.tsx`: import/props/destructure unions (#56 icon, #70 links, #83 retry).
  - `components/dashboard/connect-cms-dialog.tsx`: submit button keeps #71's plugin labels ("Test connection & save") and #83's `disabled={pending || !draftCheck.ok}` gate.
- #76 sup-editor-ai (1242 tests, tsc clean) — merged clean; the big `article-editor.tsx` rewrite landed beside #70/#80/#83/#84's sidebar additions without a conflict.
- #81 sup-article-enrichment (1305 tests, tsc clean)
  - `lib/ai/image-generator.ts`: one `ImageGenerationOptions { section?, context?, instruction? }` — #81's section brief and #76's editor guidance in the same fourth argument; the prompt takes the section form when `section` is given, else the hero form with #76's "illustrates this passage" line; #76's "Direction from the editor" line kept. `ImageGuidance` kept as a type alias.
  - Duplicate Tiptap `image` node (not a textual conflict — #76 `lib/editor/image-node.ts` and #81 `enrichment-nodes.ts` both defined `name: "image"`, and the auto-merged extension list registered both): kept #76's node (it carries `setArticleImage` and the React node view) and widened it with #81's `caption` attribute and `<figure><img><figcaption>` parse/render, so a stored enriched document opens and serialises the same way (`lib/cms/html.ts` already reads `attrs.caption`). `enrichment-nodes.ts` re-exports it and its array is now `[HeadingIds, VideoEmbed, InfographicFigure]`. Known limit: the node view draws the `<img>` without its caption; the caption survives in attrs and on publish.
  - `lib/content/generate.ts`: #81's `enhance("body enrichment")` is gated with `if (!refreshOf)` like #73's video embed — a rewrite must not gain a TOC, section images or a CTA the original did not have.
  - #78 vs #81 (TOC/bold): no overlap in practice — #78 shipped inline citations + alt-text only and left heading ids/TOC/bolding to #81, as its body says.
- #78 sup-article-format (1324 tests, tsc clean)
  - `lib/ai/__tests__/prompts.test.ts`: kept all describe blocks — #73's rewrite prompt tests and #78's citation-placement and alt-text tests. `lib/ai/prompts.ts` itself auto-merged (#78's two rule paragraphs sit in the format and SEO sections, away from #67/#73's hunks).
  - `lib/types.ts` `Keyword` (auto-merge produced two `cpc` fields): kept #80's required `cpc: number | null` with its doc; dropped #67's optional duplicate. `lib/audit/domain-analysis.ts` insert row likewise had two `cpc` keys: kept #80's `storedCpc(c.k.cpc)` (0-for-missing → null) over #67's inline finite check. 1353 tests.
- #85 sup-explainers-history (1383 tests, tsc clean)
  - `app/(dashboard)/articles/page.tsx` — the two designs of the Articles table. Took #85's `ArticleHistory` (client-side title search, status chips with counts, Image/Title/Keyword/Difficulty/Volume/Status/Date, row click → editor) as the newer, more complete design, and threaded the other tracks' columns into it rather than dropping them: `HistoryRow` gained `clicks` (#84's page-row-only 30-day clicks), `index` (#84's coverage badge + tooltip) and `canRetry` (#83's row-menu Retry); `toHistoryRow(a, canPublish, extras?)` keeps #85's tests unchanged. The `analytics_metrics` read #84 relied on is back and now **scoped with `.eq("workspace_id", scopeId)`** — #85 had deleted the guard allowance for the old unscoped read, so instead of re-adding an allowance the read was scoped, which the allowance itself had called "worth doing". `ArticleFilters` (server-side `?status`/`?sort`) is gone as in #85; `?status=review` still preselects the chip.
  - `components/dashboard/index-badge.tsx` (new): `IndexBadge`/`COVERAGE_LABEL` moved out of `gsc-blocks.tsx` (which imports `vercel.json` for the sync clock) so the client-side `ArticleHistory` can render it; `gsc-blocks.tsx` re-exports both, `check-indexing-button.tsx` unchanged.
  - `app/(dashboard)/keywords/page.tsx`: subtitle keeps #59's scoped domain (over #85's stale "Across all workspaces"); actions gain #85's `HowItWorks`; empty state is #85's, reworded to #72's button name "Research keywords".
  - `components/dashboard/workspace-switcher.tsx`: #85's popover switcher (status dots, "N of M sites used") plus #82's `PauseSiteControl` row under it; #82's separate domain line and "Paused" label dropped because the popover button already shows both.

## Merging `origin/main` back in
- `main` gained squash-merges of #56 #58 #59 #65 (already in this branch as true merges), #86 (marketing titles) and #88 (editorial-status). The five conflicts (`content/page.tsx`, `keywords/page.tsx`, `calendar-controls.tsx`, `article-editor.tsx`, `brand-icons.ts`) were main's squashed Tier-0 copies against this branch's later edits; main's copies were verified byte-identical to the Tier-0 branch tips, so ours was kept in all five. #86/#88 auto-merged. 1385 tests.

## Local-environment notes (not in the code)
- `@playwright/test` (#77) was not in the shared `node_modules`; installed locally as an overlay so `tsc`/`build` could see it. CI runs `npm ci`.
- `lib/content/__tests__/generate-quota-caller.test.ts` flaked at the 5 s default twice under the full parallel run; it now has a 20 s describe-level timeout (see #82 entry).
