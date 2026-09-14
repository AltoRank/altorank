# Fresh live onboarding retest — 13 September 2026

**The text flow works through the full draft preview before trial. The fresh output is a useful starting draft, but still falls short of a compelling first comparison article.** This run also exposed two concrete evidence-handling defects. No product code changed during the retest.

Tested commit: `adc7eeb0fd230a037688454d7ea8f4d3a66b54a9`, draft PR #215. This follows the [claim-check evaluation](./onboarding-claims-2026-09-13.md) with a new business and fresh provider responses, rather than replaying saved articles.

## Scope and observed behavior

A fresh local account/workspace onboarded **cal.com**, using the production Next.js build, local Supabase, real Anthropic and DataForSEO calls, and live public-page retrieval. The confirmed focus was **Small teams and startups / Team scheduling software**, English / Global English, with `https://cal.com/pricing` as conversion destination. Cal.com was not among the three saved articles used to develop the claim check.

| Step | Observed result |
| --- | --- |
| Infer and confirm business | Profile appeared within approximately 20 seconds; retained the inferred buyer/offering and conversion destination |
| Discover keywords | 55 candidates; missing volume remained explicitly unmeasured |
| Prepare topics | Three qualified choices, with inspectable briefs and supporting search results |
| Wait for choice | Zero articles before selection; three calendar entries |
| Reload choices | Choices persisted |
| Select first topic | Exactly one 1,921-word article created, in `review`, unpublished |
| Finish checks | 56/56 passages returned valid assessments; no quote-parser or deadline failures; seven review findings |
| Open full preview | Complete article and flagged text readable before the trial offer |
| Reload preview | Same complete article and checks persisted |
| Visit dashboard while unpaid | Redirected to onboarding; the same saved draft reopened successfully |
| Recheck database | Still one article and three calendar entries; no publication |

This began with an admin-created confirmed account and local auth callback. **Signup/email delivery, image generation, actual checkout/webhooks/entitlements, publishing, mobile layout, and deployed runtime limits were not tested in this run.** A deliberately nonworking Stripe key enabled the gate UI. Image generation credentials were absent. No production database changes, payment, merge or deployment occurred.

## Timing and cost

Timing comes from browser action timestamps and scoped database observations approximately every two seconds. Human reading and reload time is distinguished from processing time.

| Interval | Observed duration |
| --- | ---: |
| Plan click → 55 candidates | 67 seconds |
| Plan click → first two brief previews recorded | 137 seconds |
| Plan click → all three choices ready | 184 seconds |
| Choice click → run finished | 168 seconds |
| Choice click → full preview actually opened by tester | 204 seconds, including observation/reading delay |

The run record spans 6 minutes 24 seconds, including approximately 34 seconds waiting for the tester to select a topic. Planning and drafting together took approximately **5 minutes 52 seconds**, excluding initial business inference. Progressive previews help, but this is still a substantial wait before the user sees the article. This is one local observation, not a latency percentile or hosted guarantee.

Recorded provider cost was approximately **$1.43**, including approximately **$0.46 for five claim-check calls**, plus $0.12 for the whole-article review. These are recorded estimates, not invoice totals. Concurrent call durations must not be added to represent wall-clock wait.

## Keyword and topic quality

| Chosen candidate | Assessment against confirmed focus |
| --- | --- |
| scheduling software with payment processing | Strong fit for a small team evaluating booking/payment tools; selected for the draft |
| group scheduling with availability | Strong fit and a distinct team coordination task |
| hipaa compliant scheduling platform | Supported by a business offering, but drifts into healthcare providers and compliance officers instead of the confirmed initial audience |

The third choice shows that business-wide product support is not sufficient to enforce the user-confirmed buyer focus. This is a qualitative assessment of three surfaced choices; the 55 candidates were not independently labelled, so it is not a discovery/ranking precision score.

## Full draft quality

Read the [unaltered generated article](./onboarding-live-flow-2026-09-13/cal-original.md). The export normalizes Markdown formatting and preserves the delivered text and links; the browser preview is the reference for layout. [Sanitized results](./onboarding-live-flow-2026-09-13/results.json) include timings, review findings, model usage, source hashes and topic metadata.

The article follows the selected subject, gives concrete vendor examples, distinguishes annual billing, and labels its five-person scenario as hypothetical. It avoids inventing missing competitor prices. The verified Cal.com team price supports its $60/month example for five users billed annually. [Cal.com pricing](https://cal.com/pricing).

However, the article needs substantive editing before it represents a compelling first result:

- The section promising a worked comparison of **three tools** only calculates Cal.com's cost and repeats a generic checklist. It does not deliver the promised comparison.
- The pricing table has actual paid-team pricing for only Cal.com. Other rows largely tell the reader that the reviewed sources lack the answer. Those gaps honestly expose unfinished research, but leave the buyer's central question unanswered and favor the publisher through uneven evidence coverage.
- The opening definition is repeated in the first section. The same four decision criteria recur in several conclusions; the editorial check catches one of these repetitions.
- Broad claims about no-shows and fee behavior require stronger sourcing or narrower wording. A later healthcare/compliance diversion is poorly matched to this particular confirmed audience.

This is my inspection of the complete output, not an independent human review or a conversion experiment. No overall numerical quality score is assigned from one sample.

## Defects exposed by the run

### Verified publisher citations are stripped

The server logged five removed internal links: three to `https://cal.com/pricing` and two to `https://cal.com/features/payments`. Both pages were successfully retrieved into the writing evidence. In the delivered article, references to those pages are plain text while alternative-vendor citations remain clickable. The final conversion CTA survives.

`apps/web/lib/content/generate.ts` constructs `knownPages` from link targets, stored known pages and existing refresh links. It does not include the successfully retrieved `sourceEvidence` URLs. The internal-link check therefore removes valid citations on a fresh workspace. The correction should admit validated retrieved source URLs to the link check, with existing URL safety checks retained. It should not trust arbitrary model-written links.

### Approved capability evidence does not reach claim verification

The business profile retained observed source quotations supporting calendar cross-referencing and collective-event schedule checking. The writer receives those verified capabilities. `reviewFirstDraft` passes only the article's separate evidence packet to `verifyDraftClaims`.

That packet's homepage excerpt was only 2,544 characters and omitted the relevant body text; the collective-events page was absent as a dedicated source. The verifier consequently flags both claims as unsupported. Current first-party pages support their underlying descriptions. [Cal.com homepage](https://cal.com/), [Collective events](https://cal.com/features/collective-events).

These are source-coverage failures, not evidence that the underlying product claims are false. Pass approved capability quotations and source provenance consistently to the verifier, and improve extraction of relevant page-body evidence. Do not solve this by indiscriminately relaxing the verifier.

### Research and final acceptance do not enforce the promised comparison

The evidence plan asked for team pricing across four vendors. All three extra source fetches succeeded, but selected payment/integration pages instead of resolving the missing competitor prices. Generation and review still accepted a section claiming to compare three tools without actually doing so.

Research should prioritize unresolved facts necessary for the approved buying task. Where they remain unavailable, the article must narrow its promise or present a useful, explicit limitation without substituting a mostly empty comparison. Final review needs to check that section promises and comparison criteria are actually fulfilled, alongside factual support.

## What the 56/56 result means

All assigned passages received valid responses. It does not mean every claim was extracted, every judgment was right, or the article passed quality review. The UI correctly retained seven findings: one repetition and six claim warnings. Two warnings above are explained by missing evidence despite first-party support. The other four cover generic payment timing, no-show causality, premium-plan processor fees and Square's processor positioning; this retest does not label every one definitively true or false.

The article attributes payment fees to Setmore and preserves its country caveat. Square distinguishes online/API rates and plan conditions, so a different headline rate alone would not prove this passage wrong. [Setmore's published payment table](https://www.setmore.com/features/payments/us), [Square's fee categories](https://squareup.com/us/en/payments/our-fees).

## Next acceptance criteria

1. Preserve successfully retrieved publisher citations through the final preview, and carry approved capability evidence into claim verification. Add regression cases for both failures observed here.
2. Require meaningful coverage of promised comparison criteria and a worked example that actually compares the stated options. Evaluate complete articles, including repetition and usefulness, not just individual factual passages.
3. Enforce the confirmed initial buyer/offering when selecting all three topics; retain broader supported topics for later expansion.
4. Rerun this case and additional unseen businesses after corrections, then measure deployed latency and obtain independent reader judgments. Approximately six minutes to the first draft is a product concern, but this single run does not establish abandonment or conversion effects.

The core pre-trial flow passed. Consistently compelling first-draft quality remains unproven, with concrete failures now reproducible from this run. The prior code commit passed build, 3,275 unit/integration tests and 17 browser tests; this retest changed documentation only and did not rerun that suite.
