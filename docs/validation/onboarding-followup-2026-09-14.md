# Onboarding follow-up — 14 September 2026

This follows the [original release assessment](./onboarding-release-2026-09-14.md). It covers the first keyword choices and selected draft, the trial gate, and dashboard/month continuity. The original eight-case results remain the baseline. Repeated development replays are not fresh independent successes or a conversion benchmark.

## Implemented

- Removed the `node:net` import that made the latest homepage-recovery change fail the production browser bundle.
- Research now checks semantic buyer decisions before calling five different SERPs “sufficient.” Grouping shares the existing 65-call / 110-second qualification budget. Candidate ordering balances decision families before seeds within a family. Explicit onboarding retries can revisit cached incomplete checks after untried candidates.
- Task-group persistence excludes the transient qualification-run summary from its database comparison; otherwise a successful qualification could prevent the group from being remembered.
- Source extraction preserves block boundaries, keeps observed care/help links after large menus, and permits one bounded follow-up from a manufacturer help hub. Failed source URLs are not immediately requested again in that follow-up.
- A compact factual preparation stage reconstructs plan context from exact source anchors and quotations. Untraceable proposed facts are discarded. Product facts need a matching vendor host; this is a traceability filter, not proof of ownership or factual entailment. Vendor comparisons require multiple vendor hosts; aliases for the same vendor do not count twice. A comparison of one product's plans is a different task. Generation stops if no research question has supporting records, or comparison/procedure applicability checks fail. Partial coverage can still pass; the remaining questions stay explicit and cannot license invented facts. This is not yet a guarantee that all essential buyer criteria are answerable.
- Selected onboarding/month drafts use a focused writing prompt rather than the general SEO article template and adjacent People Also Ask questions. The writer receives quotations and their context, excluding the preparation model's unverified paraphrases. Final editorial and claim checks still run, and drafts remain in human review.
- At most two observed pricing pages without static price data can be rendered, under one shared 20-second deadline. Failed rendering retains static evidence. The [DataForSEO Instant Pages API](https://docs.dataforseo.com/v3/on_page-instant_pages/) supports browser rendering and a bounded custom JavaScript result. An isolated real Brevo read recovered prices missing from static HTML in 18.5 seconds for $0.0051. Prices still require their correct currency, billing period, tier and conditions.

## Validation and limits

Final local verification: **3,370 tests across 332 files passed**, including the local database tests. The production build passed. Lint passed on all 29 changed code files. The repository-wide lint command failed on generated browser-test bundles and existing source errors outside this follow-up diff; it is not a clean full lint result. All **17 standard browser tests passed without retries** in approximately 1.9 minutes. The separate gate-enabled onboarding test passed without retries in 39.2 seconds (18.7 seconds in the test body). The [sanitized summary](./onboarding-followup-2026-09-14/summary.json) records the quality controls separately from these deterministic checks. The no-mistakes wrapper remains unverified because of its previously expired Claude authentication; these are direct checks.

The gate-enabled browser run passed without retries: one preview before activation, blocked dashboard access before activation, signed fixture trial activation and repeated delivery, exactly one preserved original draft, first-month generation, and the same draft reachable from the dashboard after refresh and on mobile. Model/search calls were fixtures in this browser run; real source/model replays are separate. The earlier hosted Stripe sandbox checkout evidence remains in the original report. No new real payment or production activation occurred in this follow-up.

Development experiments uncovered and corrected additional failures: truncated preparation responses, overlong evidence URL selections, unnecessary rejection of valid quotes, duplicate failed-source reads, and a unit test whose telemetry inherited real database timers. Failed attempts remain in the protected local run history. An automatic revision experiment passed its editorial recheck but still failed a subsequent claim check; automatic rewriting remains disabled.

The new factual stage has not established that every draft is correct. The earlier general-template replays retained incomplete price comparisons, a funnel/goal feature mix-up, plan exclusions, and unsupported care explanations. A shorter prompt reduced two replay times to approximately 126 and 143 seconds, but those versions still needed factual edits. These are development observations, not release acceptance or independent human labels.

## Latest live quality assessment

These controls used the focused prompt and comparison-task classification, with real sources/models and saved topic choices. They were not three new complete onboardings. Two final validator edge-case guards and the background retry/cooldown split were added afterwards and tested separately; these outputs do not validate those edge cases live. Assessments below are by the implementing agent reading the generated articles and evidence, not an independent human evaluator.

| Case | Saved-draft time | Words | Assessment |
| --- | ---: | ---: | --- |
| Brevo | 156.2 s | 1,030 | Material rework. Starter/Standard separation improved, but the comparison remains incomplete and caveat-heavy. Discounted prices lack clear billing context; the article incorrectly says the competitor's trial is unconfirmed. Rendering fell back to static evidence. The automated review was unavailable overall because claim verification was partial; its one material finding is not a complete error count. |
| Basecamp | 96.9 s | 1,139 | Targeted edits. No findings from the automated final review, but the prose remains too close to a feature catalogue/source quotations and includes an overbroad workflow outcome. Plan/add-on scope deserves editorial review. |
| Fresha | 94.7 s | 1,052 | Factual edits and editorial refocus. Unsupported real-time availability claim, business-owner material in a consumer booking article, and distracting regional statistics. |

The fresh Plausible discovery control produced one distinct topic after 18 candidate checks and 44 budgeted calls; its first generation failed preparation. A later replay produced a draft but confused goal/event tracking with funnel drop-off analysis. This does not establish an improvement in useful keyword diversity. Buffer and Allbirds development replays also retained substantive claims issues. A successful draft or a zero-finding model review is not sufficient acceptance evidence.

## Remaining release blockers

1. **Evidence and task readiness:** distinguish essential buyer criteria from optional detail, require useful comparable evidence for every essential criterion, and make unsupported selections recoverable without presenting a weak comparison. Current partial-coverage preparation is insufficient for this acceptance bar.
2. **Output quality:** remove unsupported inferences, keep consumer/professional intent separate, and produce natural decision-oriented prose. Final review still misses errors. The offline repair experiment introduced/retained a material claim on a fresh check, so automatic rewriting remains disabled.
3. **Acceptance evidence:** rerun a fixed, diverse set of complete onboardings on the release candidate, including failure/retry paths; separately assess relevance, factual support, useful decisions and editing effort. Existing repeated topic replays are development controls, not proof of conversion uplift or an independently rated pass rate.
4. **Deployment:** apply and verify migrations 090–093, validate production billing configuration, and perform the post-deployment smoke check only after the quality bar is met. This branch remains a draft PR and has not been deployed.

The product sequence and quota continuity have strong automated coverage. The first-draft experience is **not yet ready to be called production-ready**.

Raw reports, source packets, model observations and generated HTML are stored in the local `onboarding-evidence-validation` directory outside Git. The sanitized summary alongside this report records the final verification results and latest assessed cases. Production migrations 090–093, deployment, and release approval remain outstanding; no merge or production changes were made.
