# First onboarding improvements and evaluation — 13 September 2026

**The first-draft journey is materially better supported and readable before the trial gate. Draft quality is still inconsistent: all four live samples need editorial changes. Keep PR 215 in draft; this is development evidence, not release or conversion approval.**

**Subsequent calibration:** [the route and evaluation report](./onboarding-calibration-2026-09-13.md) supersedes the revision behavior and validation counts below. Automatic model rewriting is now disabled after accepted corrections failed direct inspection.

Scope: business understanding → keyword identification → a choice of supported article briefs → one selected draft → full preview → trial decision. This follows the mechanism proposal and the user's explicit focus on the first result. The previous baseline is [the evaluation at commit 75102a6](./onboarding-simulation-2026-09-13.md). This report describes the subsequent implementation and its limits.

## What an ideal first result must do

1. Identify the actual buyer, offering, service area and conversion destination, retaining evidence and uncertainty.
2. Offer three to five distinct ideas when supported. Each should answer a real search task, fit an actual offering, and present measured or unknown demand honestly. Never fill slots with weak ideas.
3. Deliver the chosen headline and task: concrete instructions or a useful buying decision, with relevant examples, natural language and accurate claims. A long draft or high heuristic score is insufficient.
4. Let the user read the complete, saved draft comfortably on desktop and mobile before deciding on a trial. Explain the current stage and make review limitations visible.

The implemented mechanism meets much of points 1, 2 and 4. Point 3 is the remaining product-quality blocker. There is no evidence yet that the experience increases trial conversion.

## Implemented changes

- Business inference reads bounded homepage, catalog/navigation and up to three observed product/service/pricing/location pages. Ten distinct offerings can be retained and edited. Capability evidence preserves plan restrictions and exceptions; observed competitor entries must be actual hostnames present in source text.
- Discovery requests concrete editorial tasks for services as well as products. The combined ranked/discovered pool is balanced and capped at 120 before expensive buyer judgments. The final corrected search task must independently fit evidenced offerings; a CMS-selection query cannot pass solely because its audience resembles the publisher's audience. Qualification cache version is incremented.
- The writer and reviewer receive the same bounded source excerpts, including conversion/product pages. Instructions require contextual claims, natural link text, useful examples and fewer repeated definitions or template blocks. CTA enrichment uses a valid confirmed same-domain conversion URL.
- The planner derives the article shape from the qualified headline when no subtype was already chosen. A raw “software” keyword no longer automatically forces a resource-list template onto a “How to choose” guide. An existing explicit subtype is preserved.
- Reviews refer to server-indexed passages, avoiding model transcription errors across links/entities. One bounded paragraph correction can run, preserving headings and existing link destinations, followed by a whole-draft recheck. Unavailable, invalid or non-improving corrections retain the original. **Acceptance is based on reviewer findings, not independent proof of correctness; live acceptance has not yet been demonstrated.**
- Completion leads with the chosen draft. The authenticated, workspace-scoped preview renders the full article and citations, then draft checks, then eligible trial options. The onboarding completion screen no longer presents the trial offer ahead of the preview. Mobile tables scroll within their container. Progress copy distinguishes researching ideas from writing the chosen article.
- The local simulation tool can resume a saved workspace after interruption. A separate writer comparison tool uses identical saved business, brief, research and link inputs for two prompt versions.

These changes extend the existing PR's focus confirmation, expanded DataForSEO sources, structured qualification, progressive briefs, explicit topic choice, persistence and scoped spend accounting. They do not implement every broader item from the proposal, and are not a substitute for the proposed 8–10-business held-out evaluation.

## Live results

Real Anthropic, DataForSEO and public website retrieval were used. All writes were to local Supabase. The three pipeline cases used inferred profiles, not business-owner confirmation. The fourth case used the actual browser and a fresh local account; the evaluator confirmed its inferred profile.

| Business | Supported choices | First selected draft | Words | Assessment |
| --- | --- | --- | ---: | --- |
| AltoRank | 5 | How to choose an AI content writer tool for your needs | 2,283 | More concrete examples and correct Managed/Agency context; unsupported competitor comparisons and repetitive step endings remain. |
| Beardbrand | 4 | How to choose beard oil: conditioning, ingredients, and scent | 1,149 | Actual product/ingredient examples and specific sources; overconfident physiological claims and fixed usage/testing advice remain. |
| Pimlico Plumbers | 3 | Signs of mains water leaks and how to check for them | 1,136 | A draft now exists where the baseline found no qualified topic; helpful checks are undermined by an unsupported inference about leak location/responsibility. |
| Plausible | 4 | How to choose conversion tracking software for your needs | 1,859 | A complete pre-trial browser journey with a worked store example; repeated definition, broad setup/privacy claims and publisher-weighted advice remain. |

[Machine-readable results and review findings](./onboarding-improvements-2026-09-13/results.json). Unedited drafts: [AltoRank](./onboarding-improvements-2026-09-13/altorank-draft.md), [Beardbrand](./onboarding-improvements-2026-09-13/beardbrand-draft.md), [Pimlico](./onboarding-improvements-2026-09-13/pimlico-draft.md), [Plausible](./onboarding-improvements-2026-09-13/plausible-draft.md). These are evaluation artifacts, not factual guidance or approved publication.

The quality judgments above are the evaluator's assessment. There was no blinded review or controlled end-to-end before/after trial. Different inputs, choices and live search results limit comparisons. More accepted topics alone does not prove higher precision. In particular, AltoRank's Search Console/GA4 rationale still overpromises a setup benefit, and Pimlico's third brief is closer to a service promotion than an ideal first article.

### Concrete residual failures

- The AltoRank sample uses secondary reviews to make current named-tool capability/price claims. It also repeats “Expected result” endings. Stronger first-party-source and structure instructions were added afterward, but are not enough to establish consistent compliance.
- Beardbrand prescribes a testing interval and application routine beyond the supplied evidence. Product specificity improved; correctness did not become dependable.
- Pimlico adds a diagnostic inference that the cited water-company instructions do not support. Changed meter readings with the inside valve closed establish a possible leak between meter and inside valve, not precise property-boundary location or responsibility. [Thames Water's identifying-leaks instructions](https://www.thameswater.co.uk/help/water-and-waste-help/leaks/leaks-at-home/identifying-leaks). The draft's legal-deadline assertion is also unverified and needs removal or proper sourcing.
- Plausible repeats its opening definition, overgeneralizes GA4/tag setup and privacy requirements, and dismisses some alternatives without a supported comparison. Its resource-list shape exposed the raw-keyword classification problem fixed after generation.
- Automated review still produces false positives and misses real errors. Every attempted live corrective revision retained the original because edits were invalid, rechecks unavailable, or no fewer issues were found. Passage indexing improves reliable identification; it does not establish reliable editorial judgment. The added calls have latency and cost without demonstrated quality benefit so far.

## Controlled writer comparison

[Before](./onboarding-improvements-2026-09-13/controlled-writer-before.md) and [after](./onboarding-improvements-2026-09-13/controlled-writer-after.md) use the same saved AltoRank profile, brief, research and link targets, comparing the system prompt from commit 75102a6 with an intermediate updated prompt. This isolates part of the writing change; it excludes new retrieval, enrichment and revision.

The updated sample adds a worked hypothetical store scenario and replaces an invented category table with evaluation criteria. It avoids an extra standalone definition. Both versions still misstate a product limit because the frozen input lacks plan context. The old sample was 1,157 words, 93.4 seconds and $0.155 recorded model cost; the new one was 1,313 words, 102.2 seconds and $0.165. One sample per prompt cannot establish a reliable quality or speed gain.

## Browser and engineering validation

- 3,246 tests passed across 319 files; production Next.js build and TypeScript passed. Changed-file ESLint and `git diff --check` passed.
- The full local fixture browser suite passed 17/17 after local database service recovered. It includes topic selection, persistence and the new full-preview route. The final targeted onboarding browser test also passed (1/1) after the last code changes.
- The Plausible browser journey used a local production build with hosted billing-gate behavior enabled using an intentionally non-working Stripe key. Zero articles existed before selection; exactly one existed afterward, in review and unpublished.
- On the final build, the preview survived reload. A 390px viewport had a 390px document width and 342px article width. Trial options followed the article and checks. Visiting the dashboard as the unpaid account returned to saved onboarding, from which the draft remained readable. [Mobile preview](./onboarding-improvements-2026-09-13/mobile-preview.png).
- No Stripe checkout was attempted, no payment was made, and no webhook/entitlement transition or signup email delivery was tested. The dummy key proves UI placement and access boundaries only. No production schema changes, publication, merge or deployment occurred.

Some runs overlapped a local OrbStack/Supabase outage. Beardbrand was resumed; Pimlico was restarted fresh after its initial failure. Those failures and shared provider usage invalidate cross-run latency comparisons. Reported generation durations are diagnostic samples, not a hosted performance benchmark. Recorded costs exclude later reviewer replays and any unrecorded calls; they are not invoice totals.

Final passage-index review, confirmed conversion-URL preference, concise rationale wording, ten-offering UI limit, and qualified-headline template fixes were introduced during this development sequence. Not every stored draft includes every final change. The final code has regression coverage; four complete final-revision live reruns have not been performed.

## What remains before calling the first draft good enough

1. Establish an evidence-based correction pass that fixes genuine errors in saved drafts and preserves supported claims. The current reviewer/reviser is not reliably doing that; repeated stochastic prompt retries alone are insufficient.
2. For comparison articles, retrieve first-party evidence for the named alternatives or keep the article explicitly to evaluation criteria. For procedural advice, constrain steps to what the sources establish. Validate the resulting assertions, not merely whether citations exist.
3. Re-evaluate final code on held-out businesses, including a new site and a non-English market. Judge the first three topics and selected draft separately. Target no material unsupported claims, no task drift, and a useful concrete answer before treating a draft as compelling.
4. Measure time to first useful choice and finished draft on stable infrastructure, then test actual user comprehension and trial conversion. Complete isolated Stripe test checkout/webhooks separately before release.

There is no missing product direction or credential blocking the code work. The remaining blocker is demonstrated output quality, followed by hosted payment verification for release. The current PR is concrete and reviewable; it should remain a draft while those gaps are resolved.
