# Onboarding production-readiness work — 13 September 2026

This work addresses the failures in the [fresh Cal.com flow](./onboarding-live-flow-2026-09-13.md). Release approval depends on the fresh-run results below; passing code checks alone does not establish content quality.

## Changes

- Successfully retrieved publisher pages now survive the internal citation check. Quotation-only profile evidence does not establish current URL reachability.
- Approved source quotations reach both first-draft reviewers with their source URL. Relevant product pages are read again, and large script-heavy pages yield main-body evidence rather than navigation-only excerpts.
- The evidence planner can retrieve six additional observed references, prioritizing missing competitor pricing needed by the selected task. No guessed URLs are allowed. Input size, call concurrency and deadlines remain bounded.
- Writing instructions require comparisons to evaluate the same criteria across the promised options. Review explicitly flags an unfulfilled comparison or a mostly empty pricing table. Automatic rewriting remains disabled.
- The confirmed buyer and offering constrain topic eligibility. Final approval requires an explicit focus decision; missing decisions remain pending, mismatches are rejected, and earlier cached qualification is invalidated.

## Checks completed before the live run

On the intermediate code commit `acb039b`, production build and TypeScript passed, changed-file lint passed, and the full local suite passed 3,297 tests across 327 files. CI build and unit tests passed; the browser retry and subsequent clean run are recorded below.

The existing task/offer regression passed 20/20 live-provider checks. New focused cases passed 6/6 after making the required response shape explicit: reject healthcare drift for a startup buyer, accept team payment scheduling, and accept healthcare when explicitly selected. An earlier run returned 5/6 because one supported response omitted its focus decision; it was correctly kept unavailable.

A fresh-source review of the old Cal.com article now identifies the missing competitor prices and the promised three-tool comparison that only calculates Cal.com's cost. An old-draft claim replay remained partial and found new source mismatches; it is not a quality pass. Its evidence packet differed from the original, so findings cannot be interpreted as a controlled precision comparison.

## Fresh Cal.com run

Commit `90312e5` produced 47 candidates, three focused choices and one 1,708-word draft. Planning took approximately 167 seconds; selection to completion took 187 seconds, including review. All 46 passages received valid claim-check responses. Recorded provider cost was approximately $1.40. Verified publisher pricing citations survived. Topic reload, complete preview before trial, preview reload and unpaid-dashboard return passed; exactly one unpublished article remained.

The [unchanged generated article](./onboarding-production-readiness-2026-09-13/cal-original.html) now works through a real Cal.com/Calendly decision using sourced plan differences. Current primary pricing pages support the quoted CRM-plan and team-price distinctions. [Cal.com pricing](https://cal.com/pricing), [Calendly pricing](https://calendly.com/pricing).

The sample still needed editing: a proposed round-robin test incorrectly treated one busy host as proof that the remaining slot must disappear; generic savings and compliance claims lacked support; a workflow tier claim needed qualification. The reviewer also falsely called an actual linked cross-reference a missing link because it received only plain text. These findings are not hidden by the complete-passage count.

The three choices answered nearly the same selection task. The subsequent first-choice planner now performs a bounded semantic overlap check, retaining one ranked representative per buyer task. Live replay collapsed those three synonyms in both runs, while retaining the separate payment-scheduling and group-availability controls in both runs. All four replies were complete valid partitions, not the one-topic fallback.

The subsequent writer/reviewer instructions distinguish all-host availability from any-available routing, avoid unsupported time-saving quantities and specialist diversions, and provide the reviewer the article's actual link metadata. The new regression passed 6/6: two detections of the invalid routing test, two clean corrected controls and two correctly accepted linked-reading controls. These are development cases, not independent human approvals.

## Independent review and final run

The no-mistakes wrapper could not complete review because its Claude OAuth session had expired. Retrying reproduced the authentication failure. A separate Codex review completed and found that the opportunity-version bump could discard duplicate-coverage evidence for already planned or published topics. The fix separates historical coverage from fresh candidate eligibility, with a regression for version, focus and age changes. A follow-up independent Codex review of the final changes found no further correctness, security or maintainability regressions and explicitly checked workspace scoping. The wrapper itself did not pass; the completed standalone review is the fallback evidence.

## Fresh Tally run and follow-up

The fresh Tally run on `acb039b` found 47 candidates and produced two distinct, focused choices: comparing conditional-logic form builders and embedding a form. The two choices persisted after reload, and no article existed before selection. Planning took about 197 seconds; the chosen 1,733-word draft completed in 207 seconds. Recorded provider cost was $1.42. It remained unpublished in review.

The [original saved article](./onboarding-production-readiness-2026-09-13/tally-original.html) and [results](./onboarding-production-readiness-2026-09-13/tally-results.json) preserve the failed quality sample. Its useful comparison criteria were weakened by unsupported interface/evaluation-order claims, an unsourced buyer-surprise assertion, third-party competitor prices and a recommendation based on which vendor's documentation was available. The automated review showed seven findings, including duplicates across review methods. A truncated claim batch left 37/51 passages checked. This was not a publication-ready sample.

The source pipeline could find vendor homepages through reviews but stopped before following those homepages to their own pricing or documentation. A bounded follow-up now permits three further reads, with twelve retrieved pages total. Observed pricing links survive the 80-link cap even after a large product menu. A direct live evidence replay retrieved original WPForms and Formidable pricing, rather than relying solely on the reviewer's prices.

A conflicting general writer instruction explicitly permitted unsourced “most sites” claims. It is removed. Final instructions also prohibit inventing product-interface/evaluation-order details and treating missing competitor evidence as a product disadvantage. Truncated claim batches can split once within the existing eight-call/three-concurrent/90-second limits. Other incomplete responses remain partial. An offline replay of the stored Tiptap article had 62/69 valid passage responses; its rendering creates different passage boundaries from the generation HTML, so it is not a controlled 51-passage coverage comparison or a quality pass.

The automated locator initially missed wrapped draft links. Screenshot inspection showed the link text on two lines; clicking the visible linked text opened the preview. The same miss occurred with an ordinary anchor, so the temporary navigation change was reverted rather than attributing an automation hit-target problem to client routing.

The follow-up local suite passed 3,301 tests across 327 files, production build/TypeScript and changed-file lint. CI on `87257ed` passed all 17 browser tests on their first attempt after warming the POST worker routes before timed assertions. The prior run's one retry remains recorded; the timeout was not increased.

The final Tally generation replay uses its saved profile and qualified choices in an isolated local account, with fresh live evidence, writing, reviews and persistence through the actual choice route. This tests the fixes against the observed failure, not an unseen discovery holdout.

Signup/email delivery, image generation, real checkout/webhooks, publishing and deployed runtime limits remain outside these local text-flow tests. No production data changes, payment, merge or deployment occurred.


### First Tally replay

The first saved-topic replay produced a [2,143-word draft](./onboarding-production-readiness-2026-09-13/tally-replay-original.html) in 238 seconds, recording $1.25 for fresh generation/review (discovery was reused). The core Tally/WPForms choice is now based on actual plan differences rather than source availability. The complete preview and trial placement were inspected. Source checks covered 48/51 passages; three provenance failures stayed partial.

The ten displayed findings are not ten independently confirmed errors. The Jotform source attribution and notification-action wording need correction. The payment-block inference is disputed: the supplied documentation says “any block,” and the reviewer may be demanding unnecessary specificity. The entity-rendering warning was a false positive: the browser showed `>`, while the whole-article reviewer saw `&gt;`. Review now uses the shared HTML decoder, with a regression. Broader unneeded website-builder sections still weakened focus, and the draft reused an older blog price despite a current vendor pricing page in its packet.

The subsequent selected-preview writer omits broad keyword expansion, AI-overview and competitor-list prompts while retaining the full saved research and approved brief/source packet. Its automatic length target is capped at 1,200 words, with the same target passed to scoring; explicit user length choices remain intact. Pricing instructions prioritize current vendor terms over blog snapshots and omit exact costs when discounts or conflicting terms cannot be resolved. This is scoped to the selected first draft's source-verification path.


## Final code verification

Code commit `ec372d2` passes 3,303 tests across 327 files, production build/TypeScript, changed-file lint and whitespace validation. A further independent review identified that an explicit length target could still be accompanied by contradictory SERP-derived length guidance. The prompt now omits that guidance when an explicit target is supplied, with a regression test. The source-verification writer and scorer receive the same target.


## Final focused Tally replay

On `ec372d2`, the saved-topic route replay produced the [unchanged 1,372-word draft](./onboarding-production-readiness-2026-09-13/tally-focused-original.html) in 150 seconds from selection, with $0.88 recorded for generation/review. [Sanitized results](./onboarding-production-readiness-2026-09-13/tally-focused-results.json) include the source hashes, review coverage, findings and browser checks. Fresh discovery is not included in that time or cost. The earlier fresh Tally discovery took 197 seconds and offered two distinct choices from 47 candidates.

The final article stays on the buyer's comparison task, evaluates three named products against shared criteria, distinguishes free and paid logic access, and includes a concrete lead-qualification example. The irrelevant website-builder sections, invented notification-action list and conflicting exact prices seen earlier are absent. It is a useful first draft requiring targeted edits, rather than a broad rewrite. This assessment is by the implementing agent on a development example, not independent human validation or a controlled improvement estimate.

Full browser inspection confirmed the entire article appears before the trial offer, survives reload, and remains available after an unpaid dashboard visit returns to onboarding. Exactly one unpublished article remained in review. No checkout or publishing was performed.

The whole-article reviewer found no structural or product issues. The passage verifier returned valid results for 29/36 passages, leaving seven quote-validation failures explicitly partial. Its one displayed warning was a false positive: the stored Jotform homepage excerpt actually says “CRMs, cloud storage apps, and more with Jotform’s 150+ integrations.” The checker claimed the number was absent from that homepage. Exact quote validation protects response provenance but does not establish the accuracy or completeness of model judgments.

Manual inspection also found small issues the automated checks missed: the hypothetical budget branches omit exactly $5,000; a Jotform redirect is attributed to a review excerpt that documents page skipping but not redirect behavior; and repeated definition/source-excerpt narration could be tightened. These are targeted first-draft edits, but the missed and false warnings mean the check display is not yet reliably prioritizing them.

## Earlier release decision, before the trial/dashboard follow-up

The keyword → choice → saved full preview → unpaid return path is implemented and exercised. The final sample clears a useful-first-draft bar, with the limitations above. It does **not** establish consistent, compelling first-draft quality across businesses, and the quality checker still needs validation/reliability work. Keep PR 215 in draft rather than describing this as an unqualified production-readiness pass.

The remaining release work is concrete:

1. Validate the bounded recovery/adjudication implemented below across full drafts. Partial coverage and model errors still occur; do not suppress warnings merely because another reviewer stayed silent. Retain the captured false positive and missed attribution/boundary examples as regressions, with clean controls.
2. Run the final flow on a held-out set of materially different businesses and obtain independent human labels for topic usefulness, duplicate choices, factual edits, task completeness and whether the first draft is compelling enough to continue. The proposal suggested 8–10 businesses; this has not been completed.
3. Verify the deployed worker deadlines and required migrations before release. Email delivery and images remained unverified. Hosted sandbox billing/webhooks were subsequently exercised as described below. These are not explanations for the text-quality gap.

No production configuration or data was changed. No merge, deployment, payment or publication occurred.


## Bounded verification recovery

The final follow-up adds a single targeted second pass using only unused capacity within the existing eight-call, three-concurrent and 90-second ceilings. It rechecks invalid responses and unsupported claims. Exact original claim identities must survive: neither omission nor fabricated evidence can erase an initial finding or an initial evidence-validation failure. An independent review found the invalid-evidence omission edge case; it was fixed with a regression, and the follow-up review reported no findings. Untraceable original claims remain partial.

The [three live-provider controls](./onboarding-production-readiness-2026-09-13/recovery-controls.json), using the complete frozen source packet, correctly accepted the Jotform integration count and page-skip attribution, and retained the unsupported redirect attribution. All three passages were checked in two calls. This is a development regression, not proof of reviewer accuracy across articles.

The [full stored-article replay](./onboarding-production-readiness-2026-09-13/recovery-full-draft.json) remained partial at 49/51 passages: its recovery call exhausted the shared deadline and retained the original warning. The stored HTML has different passage boundaries from the live generator's 36-passage input, so these counts cannot be compared as a coverage improvement. Bounded recovery is implemented, but this full-article result remains a release limitation.

After the recovery changes, all 3,312 local tests across 327 files passed with two workers. Two earlier full-suite attempts hit unrelated local database/import timeouts under heavier concurrency; these were not assertion regressions and are not hidden by the successful bounded-concurrency run. The test timeouts were not raised. Production build/TypeScript, changed-file lint and whitespace validation also passed. CI on `ec372d2` passed build and all 17 browser tests; the latest recovery-commit status is available in the [PR checks](https://github.com/AltoRank/altorank/pull/215/checks).


## Trial gate, dashboard and first-month preparation follow-up

The gate now shows the customer's domain, confirmed buyer/offering, saved preview, supported planned topics, qualification reasons and measured keyword demand where available. It states Managed's 100-article calendar-month allowance, the current month's usage including the preview, and the remaining allowance after activation. Capacity is not presented as a promise of 100 useful topics or a traffic forecast. Monthly and yearly prices retain the seven-day/card/tax/cancellation terms.

Checkout now lands on the dashboard. Its first section leads with the exact onboarding article and a review/edit action, followed by actual planned dates, ready/writing/needs-attention states and account-wide usage. The existing empty analytics move below this. Readers can open the other ready drafts, adjust the plan, review evidence, approve, connect a CMS or export, then connect Search Console to measure results. The editor carries retrieved citation pages into its link audit, avoiding a false warning for the already-read pricing page; score captions describe on-page quality and citation readiness, not predictions of ranking or citation.

Activation creates one durable first-month run per workspace. It preserves custom cadence and the first draft. The next thirty days are filled only with qualified tasks, bounded by cadence, the existing 60-entry calendar cap and available account quota. Each article is prepared in a separate invocation, sequentially per workspace, independently of its publication date. Database leases prevent duplicate workers; interrupted work is recovered by the dashboard or generation cron; saved articles are attached instead of regenerated after a lost response. Paused writing, lost entitlement and exhausted allowance block new work. Two automatic attempts are followed by a visible manual retry. Generated articles remain in review.

Two additional fixes came from the real sandbox test: activation database errors now fail the webhook for redelivery; and a definitive Stripe request rejection releases its reservation. Ambiguous Stripe/network outcomes retain their idempotency key, and cancellation resolves the same attempt before closing it. Repeated activation does not overwrite a cadence the customer changed later.

### Hosted sandbox evidence

The fresh Plausible onboarding run produced 35 candidate keywords, two first choices and a 1,396-word preview in 237 seconds after selection. It cost $1.56 including discovery. The automated claim check covered 44/44 passages and reported two editorial findings. The complete preview was readable before the gate.

With the local production build and an isolated Stripe sandbox product, the actual hosted monthly checkout accepted Stripe's test card and activated a seven-day Managed trial at EUR 69/month. The application and Stripe both reported `trialing`; the first dashboard and sidebar agreed on 1/100 used and 99 remaining. The dashboard's first action opened the original article ID. The annual option opened a EUR 690/year checkout with the same trial terms, and cancelling it returned to the saved Tally draft without a subscription.

The pre-group-persistence Plausible preparation run then completed four further drafts: 1,601, 1,476, 1,293 and 958 words. Each remained in review; none was published. Completed generation jobs took roughly 165, 244, 249 and 112 seconds, all inside 300 seconds locally. Local timing does not itself verify the deployed runtime. The sandbox account's checkout branding belongs to the existing test account; this does not validate the production Stripe branding or price configuration. Email and image providers were deliberately absent.

After preparation, the dashboard account had five articles used and 95 remaining. A hash comparison confirmed that the onboarding preview content was unchanged. Total recorded provider spend for discovery, the preview and this first-month run was $5.80. The [sanitized trial and month results](./onboarding-production-readiness-2026-09-13/trial-first-month-flow.json) preserve the final state.

The first-month expansion exposed a semantic-overlap issue: comparing new tasks alone could bring back earlier synonyms. Top-ups now include existing tasks, and initial grouping decisions are persisted with the qualification evidence. Two replays without those historical keys still admitted an overlapping comparison; a replay that first stored the current grouping then expanded the month added only the distinct funnel-analysis task and reintroduced no covered task. This establishes consistency with the recorded grouping, not independent human agreement with every grouping decision.

### Verification and remaining limits

- Full local unit suite: 3,329 tests across 328 files passed with two workers; the final repeat-activation regression and related tests also passed (68 tests).
- The full standard browser suite passed all 17 tests without retries in 2.1 minutes.
- The gate-enabled browser test passed without retries in 41.3 seconds. It covers complete onboarding, preview before the gate, unpaid-dashboard redirect, signed subscription activation, duplicate events, completion of remaining drafts, original-draft identity, dashboard reload and mobile-width rendering. Stripe's hosted form was tested separately above; fixture events are not claimed as payment tests.
- A real local database check raced twelve lease claims and got one winner. Cross-account RLS, service-only claim privileges, expired lease recovery and retry of an expired terminal lease passed.
- Independent code review found a terminal-lease interruption gap and a false successful retry response; both were fixed, and the follow-up review reported no findings in those bounded files. A later topic-group review found that timestamp-less legacy evidence could be overwritten by a concurrent grouping save. The write now compares the entire JSONB snapshot; a real database regression verifies both successful legacy writes and preservation of newer qualification. The related 15 unit tests pass.
- The first billing browser-test attempts exposed test adaptation issues (a self-host-only button, then a title omitted from the fixture's select). They were corrected without increasing timeouts. A stale Next dev cache returned 404 before tests began; a clean cache resolved it. A build attempted beside a dev test encountered a partially rewritten generated route type; build verification is run after the browser server stops. That serial build then caught a missing required `qualityNote` field in a planner anchor; the field was added before the final rebuild.

The preview is useful but still needs targeted editorial edits. The Plausible comparison combines one plan's retention with another plan's features, uses one nonresponsive comparison-table cell, and makes an inconsistent statement about feature-based pricing. The checker caught the first two, not every weakness. First-month topic diversity remains a qualitative judgment, and the broader independently labelled 8–10-business holdout has not been completed. The mechanical flow and truthful handoff are substantially stronger; no conversion uplift or consistently publication-ready article quality is claimed.

Apply migration 092 before deploying these changes (090 and 091 are also required by the earlier work). Configure the worker URL/secret and the deployment's actual Stripe prices/webhook. No production schema change, real payment, publishing, merge or deployment was performed. The draft PR remains reviewable without treating uncompleted editorial validation as a passed check.

Final browser follow-up found and fixed a contradictory “Nothing is scheduled” recommendation after every planned draft was ready: the dashboard now counts upcoming calendar entries with saved drafts. The gate-enabled onboarding regression passed again without retries in 37.7 seconds, including an assertion against that contradiction. Four redeliveries of the original sandbox checkout/subscription events left five articles, one preparation run and the custom two-per-week cadence unchanged. A final quota-boundary regression verifies that completing the month with zero allowance remaining is marked ready, with no further generation (11 first-month tests passed).

The final production build (including TypeScript), changed-file lint and whitespace checks passed after the dashboard and quota-boundary corrections.
