# Onboarding release evaluation — 14 September 2026

The restarted eight-business development evaluation freezes production code at `27f7bc0`. The initial run on `f3a6f95` was stopped after the planning failures below; those observations are retained. Four independent local workspaces run concurrently, so timings are observations under shared local load, not hosted performance measurements. These businesses were not used in this branch's prior draft calibration: Basecamp, Buffer, Crisp, Brevo, Bellroy, Allbirds, Fresha and Fatture in Cloud (Italian/Italy). See the [case manifest](./onboarding-release-2026-09-14/manifest.json).

The runner accepts the inferred primary buyer/offering and chooses the first supported article. Those are simulated user decisions, not confirmation from the businesses. It invokes the production `runOnboarding(..., {firstDraft: 'choose'})` pipeline, deferred voice/link preparation, and `generateArticle(..., {verifySourceClaims: true})`, persisting only to local Supabase. It does not substitute a keyword after failure. This evaluates fresh discovery and draft generation; the prior browser and hosted sandbox tests separately establish gate/checkout mechanics.

Before reading the resulting drafts, the assessment bar is:

- **Useful first choice:** clear fit to the accepted buyer/offering, a concrete task and no obvious synonymous alternatives presented as distinct decisions.
- **Useful first draft:** answers its title and task, uses concrete supported detail and comparable criteria where appropriate, and needs only targeted edits rather than structural rewriting.
- **Evidence:** distinguish unsupported factual claims from missing source checks. Check plan/price/feature combinations, numerical claims, attributed instructions and operational examples against the collected excerpts. Automated scores and absence of findings are not factual approval.
- **First impression:** the customer can see why the article matters and what to do next. A failed discovery, missing draft or generic content is an unsuccessful experience, even if it fails safely.
- **Operational outcome:** record every case, qualification failure, provider error, cost and latency. A locally completed invocation exceeding 300 seconds is a deployment concern, not a timing pass.

Assessment is by the implementing agent. It cannot supply the independent human labels requested by the original proposal, establish conversion uplift, or estimate quality across all businesses from eight examples. Raw source packets and full database reports remain in protected local output; only reviewed/sanitized artifacts belong in the repository.

## Production preflight

The [read-only snapshot](./onboarding-release-2026-09-14/production-preflight.json) confirms the current hosted app is Ready on Vercel Hobby, Fluid Compute enabled, deployed in `fra1`. Node is configured as 24.x, while CI tests Node 22. No runtime compatibility failure is inferred from that difference.

The app origin and all required environment-variable names are present. Sensitive Stripe values cannot be read through the available API; presence does not verify the live secret, product/price activity or webhook configuration. No live checkout was created.

The production database has migrations 088 and 089, but not 090–093. The `research_evidence` column and first-month tables are absent. Apply migrations 090–093 before deploying this branch. Inspection ran inside a read-only database transaction and read schema metadata only.

Hobby with Fluid Compute supports a 300-second maximum. The source routes request 300 seconds, matching that plan's ceiling. This configuration check does not replace a hosted runtime test. [Vercel duration documentation](https://vercel.com/docs/functions/configuring-functions/duration). Sensitive values are intentionally unreadable after storage. [Vercel sensitive environment variables](https://vercel.com/docs/environment-variables/sensitive-environment-variables).

No production schema change, configuration write, payment, email, publication, merge or deployment occurred during this preflight.

## Failures found before draft quality could be judged

Basecamp produced qualified topics, but group persistence encoded 10–15 KB JSONB snapshots in a URL filter. A direct read using one of those real snapshots reproduced HTTP 414. The earlier database regression used a small record and missed this transport-size failure. Migration 093 adds a service-only compare-and-set RPC: the snapshot travels in the POST body, and only `taskKey` changes if the full current snapshot matches. A 37,534-byte legacy snapshot now saves; stale qualification is preserved and authenticated users cannot call the service function.

Buffer's first run found no qualified choices. Both failed/empty planning paths could fall through to the older automatic-generation branch despite being in explicit-choice mode. The pipeline now ends with a skipped-draft/refine-focus outcome; it neither researches a second fallback nor writes without a choice. Two regression cases cover empty and failed planning.

The initial run was stopped after these findings, including a Crisp inference that had just started. No resulting draft is counted as a successful evaluation. The eight cases restart fresh on the corrected implementation; this is development validation, not an untouched holdout or a prompt-quality improvement experiment.

The two corrected paths pass 39 focused tests. An existing claim-verification test also had a malformed parameterized fixture: array rows were spread into arguments instead of passed as the intended claims array. Object-shaped cases now exercise omission and invalid evidence correctly; all 26 claim-verification tests pass. TypeScript and changed-file lint pass.

The full local suite passes **3,334 tests across 328 files** after updating the two planner fixtures to expose the new RPC. CI first caught those outdated mocks (`rpc is not a function`); this was corrected without changing production behavior. The gate-enabled browser test passed without retries in 34.5 seconds, and an independent bounded review of the RPC and empty-choice fixes reported no findings. Changed-file lint has zero errors and two pre-existing unused-parameter warnings in the pipeline test fixture.


## Eight-business outcome

**The mechanism tests pass; the fresh content cohort does not establish general production readiness.** Six of eight cases produced a draft. On implementer reading, two needed targeted edits, four needed material corrections or rework, and two did not reach a topic choice. This is a small development sample, not a measured population success rate. The [case summary](./onboarding-release-2026-09-14/cohort-summary.json) retains failures, costs, timings and review coverage. Original HTML artifacts in the same directory intentionally retain the defects; they are not approved for publication.

| Business | Candidates / choices | First draft | Assessment |
| --- | ---: | ---: | --- |
| Basecamp | 43 / 1 | 1,110 words | Useful specific workflow. Tighten project/workspace terminology and remove universal outcome language. |
| Buffer | 58 / 1 | 1,083 words | Material rework: a promised multi-tool collaboration comparison substantiates only Buffer. |
| Crisp | 67 / 1 | 1,483 words | Useful structure, material corrections: plan allowances, channel exclusions and missing-price inference. |
| Brevo | 0 / 0 | None | Rendered profile inference succeeded, but keyword crawling returned HTTP 404 and the site-vocabulary guard stopped discovery. |
| Bellroy | 57 / 1 | 1,384 words | Material corrections: table says softside is cheaper in one of three pairs; prose says two. Repair/material claims also need correction. |
| Allbirds | 56 / 2 | 864 words | Material rework: transfers Merinos-brand care instructions to Allbirds and the whole category. |
| Fresha | 25 / 1 | 1,099 words | Useful consumer booking walkthrough; remove custom-software diversion and qualify the free-app assertion. The accepted audience was consumers, not salon operators. |
| Fatture in Cloud | 54 / 0 | None | Qualification remained pending or rejected: timeouts, incomplete search classification and unread existing ranking pages. The calendar was not filled with unchecked candidates. |

The six successful cases took 159–212 seconds from automatic topic selection through preparation and saved draft. Discovery including profile inference took 193–227 seconds for those cases: approximately six to seven minutes end to end. Four concurrent local runs affect timing, and the inference/choice/generation stages are separate HTTP invocations in the app. These measurements neither prove a hosted deadline violation nor establish acceptable user patience. The full original cohort cost $8.839093, including $0.112599 for Brevo and $0.458130 for Fatture in Cloud. Failed-run spend was recovered from their isolated local database ledgers; missing report spend was not treated as zero. The runner now records completion time and attempts spend accounting on failure.

Source-check coverage was complete for Basecamp, Buffer, Allbirds and Fresha; partial for Crisp (40/41 passages) and Bellroy (34/42). Complete coverage means the model returned validated records, not that all claims were correct. Manual reading found mistakes and false positives in both categories.

## Corrections and controlled replays

The article-link extractor previously read navigation first. Large menus displaced relevant source links before either the 400-link scan limit or the 80-link output limit. It now reads main-content references first, retaining pricing priority and bounded output. On Buffer's saved research, this exposed additional vendor pricing/documentation and changed the evidence packet from publisher-only pricing to multiple primary vendor sources. One newly followed link returned a PDF; the extractor now rejects binary content types and PDF signatures instead of treating encoded PDF bytes as factual text. No guessed vendor URLs or additional unbounded crawl were added.

The reviewer could label harmless hypothetical inputs or an article roadmap as unsupported even while explaining that no source was needed. Its recovery contract then required retaining the exact original item, leaving no valid way to classify that scope error. An explicit `not-factual` disposition now preserves the original quote and category with a reason and no evidence. It is accepted only for qualitative items; product claims cannot be relabelled during recovery. It does not establish truth, remove separate editorial findings, or turn incomplete coverage into approval. [Three real-model repetitions of paired development controls](./onboarding-release-2026-09-14/claim-scope-controls.json) all retained detection of a false plan allowance and guaranteed outcome, without flagging harmless examples or a correctly sourced seat allowance. Synthetic controls are not independent human validation.

Writer guidance now explicitly preserves brand-specific applicability, distinguishes missing excerpt text from absence of a feature/price, requires worked scenarios to reconcile plan seats/channels/AI usage, and checks table summary arithmetic. These are constraints to evaluate, not evidence that the model obeys them.

Three [controlled production-generator replays](./onboarding-release-2026-09-14/replay-summary.json) retained the same selected topics and saved workspace/voice, while refreshing research and generating new text:

- **Buffer:** 1,089 words in 186 seconds. Now compares Buffer, Planable and Statusbrew with actual primary sources. It still pairs Statusbrew Agency pricing with a feature evidenced for Premium and infers a mandatory approval guarantee. The checker flags these; the draft still needs material corrections.
- **Allbirds:** 757 words in 153 seconds. Now says Merinos' instructions apply to that brand and tells readers to check their own manufacturer. It still introduces unsupported care explanations and storage claims. Brand scope improved, but this remains weak as a compelling Allbirds-specific first result.
- **Crisp:** 1,417 words in 205 seconds. The worked example now accounts for seats, channels and an approximate AI-credit allowance. The reviewer flags unsupported channel-tier attribution, an ElevenLabs plan claim and Retell automatic-sync behavior. Manual review also questions claims that missing source text establishes no Fini free tier/monthly minimum, and the characterization of Retell concurrent-call capacity as free calls. This is not factual approval.

All three returned complete claim-check coverage in the replay. The remaining issues show why completeness and automated scores cannot stand in for quality. These are development replays after observing errors; they do not replace the original eight-case results or constitute an untouched holdout.

## Release decision and remaining work

Keep PR 215 in draft. The gate, quota and dashboard continuity have strong local/browser/sandbox evidence, but the content cohort fails the broader quality bar. No merge or production deployment occurred.

The next substantive content change should bind every named product/plan comparison cell and worked-scenario allowance to its own source evidence before prose generation. A partial page must not support a negative claim such as “no free tier.” The selected article also needs an evidence-sufficiency decision for its core task: a manufacturer's care guide cannot be delivered convincingly from only another manufacturer's instructions. Weak evidence should lead to a clear retry/refine choice or a narrower user-approved brief, without padding the calendar or silently changing the chosen task. More generic prompt instructions alone did not resolve these failures.

Research recovery must be evaluated for a readable inferred profile with an inaccessible crawler, and for a non-English domain whose initial checks remain pending. Existing safe stops should remain until a bounded recovery supplies evidence. Do not loosen qualification just to improve the completion count. After those mechanisms change, repeat materially different fresh businesses and obtain independent human ratings of the first choices and drafts.

Operational release still requires migrations 090–093, a hosted worker-duration/continuation test, and actual production configuration verification of Stripe/webhook/worker settings. Environment-name presence is not credential validity. Email and image behavior were outside these isolated runs. The shared quota is an allowance, not a guarantee of 100 useful drafts; first-month preparation must stay limited to supported topics.

Validation of the final source/reviewer changes: **3,340 local tests across 328 files passed**, TypeScript passed, and changed-file lint passed. The earlier gate-enabled browser check and CI run on `897f479` passed, including the standard browser suite and gate flow. The latest commit must also clear CI before release consideration. The no-mistakes wrapper did not pass: its previously observed expired Claude authentication required direct checks; the bounded independent review mentioned above covers the RPC/empty-choice changes, not a claim that the wrapper succeeded.
