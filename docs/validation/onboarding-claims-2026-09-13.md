# Claim-level checks for the first onboarding draft — 13 September 2026

**The new check detected all three known material errors in full articles. Four corrected passages were checked without being flagged. This improves error detection, but does not establish complete factual accuracy or publication readiness.**

This implements the next step from the [calibration assessment](./onboarding-calibration-2026-09-13.md). It applies to the selected first onboarding draft and its full preview before the trial gate. Keyword discovery and ranking are unchanged in this pass.

## Implemented behavior

Each article passage is assigned to a bounded claim check. The model returns individual factual assertions as article quotes, their supplied-source evidence, and a supported/unsupported/contradicted judgment. The server verifies the provenance of article and source quotes, retains the original prose, and records which passages received valid responses. A source match verifies provenance, not whether the source logically proves the claim; that judgment is still fallible.

Checks run alongside the existing editorial review. Specific unsupported or contradicted claims remain visible even if the whole-article reviewer reported no issues. Incomplete checks cannot produce an overall clean status. The preview shows the flagged text and explains incomplete checks and the distinction between a source gap and a false claim. Automatic rewriting remains disabled.

Only onboarding callers request the new check: direct topic choice, the inline onboarding pipeline, and an internal draft invocation associated with an onboarding run. Routine/manual article generation keeps its existing path. Source checks are limited to eight batches, three concurrent calls, a 90-second overall budget and the existing shorter shared research budget when present. Individual calls are capped at 60 seconds. These are ceilings, not an end-to-end onboarding latency guarantee.

Source extraction now uses the existing shared HTML entity decoder. Previously, valid quotes containing apostrophes were rejected because sources retained `&#x27;` or `&#8217;`. Verification accepts equivalent entities, whitespace and quotation typography, while rejecting invented words and ellipsis-joined excerpts. Invalid claims and omitted or duplicate passages do not discard other valid findings; their coverage stays incomplete.

## Full-article evaluation

The source packets and original saved articles were fixed. Labels were not sent to the model. After initial experiments exposed false positives and quote problems, the final prompt ran on three originals and three controlled corrections.

| Article | Original target | Detected with the correct reason | Valid passage responses in original | Corrected passages checked without flags |
| --- | --- | --- | ---: | ---: |
| AltoRank | Worked example incorrectly requires manual first drafting in Surfer | Yes: the source describes an article generator | 62/64 | 1/1 |
| Beardbrand | Unsupported minimum two-week routine and adjustment explanation | Yes: no source establishes that duration or physiology | 39/40 | 2/2 |
| Pimlico | Meter movement treated as proof of property-boundary location/responsibility | Yes: the source does not establish that conclusion | 38/41 | 1/1 |

The target errors passed direct inspection of both the quote and finding reason. The corrected passages contain conditional product tests, preference-based advice, or a source-aligned interpretation. All four were present in the verifier's checked-passage set; absence of a flag in an unchecked passage would not count as success.

These are **three positive targets and four negative-control passages**, not seven independently approved articles. The corrected articles retain the rest of the original text and are not complete editorial rewrites. Passage coverage counts valid returned assessments; it cannot establish that the model extracted every relevant claim. One corrected article had complete returned coverage; the other two were partial. The final parser additionally preserves valid passages from partly omitted batches; that deterministic retention change was unit-tested after the recorded provider runs and does not change the target scores.

### Remaining weaknesses

- The verifier still flags some harmless generic examples, including an illustrative caption-generation speed and a hypothetical composite workflow. It sometimes reads suggested sequencing as a universal factual rule. Source absence alone is not a useful publication verdict.
- Some source quotations remain malformed, and one control run hit an individual-call deadline. The code records these as incomplete; it does not retry until a favorable answer appears.
- Supplied excerpts can be incomplete, stale or secondary. Supported-by-this-packet is not proof of current real-world correctness. More precise first-party retrieval remains important for named comparisons.
- No unseen-business holdout, independent human evaluation, fresh end-to-end model-backed onboarding run, or conversion experiment was completed in this pass. New drafts do not yet automatically benefit from a validated correction pass.

[Sanitized results and target scores](./onboarding-claims-2026-09-13/results.json) retain model usage and findings. Public summaries hash external source quotes; the replay outputs retain the exact excerpts for local inspection. Controlled articles: [AltoRank](./onboarding-claims-2026-09-13/altorank-control.md), [Beardbrand](./onboarding-claims-2026-09-13/beardbrand-control.md), [Pimlico](./onboarding-claims-2026-09-13/pimlico-control.md). The [independent-review worksheet](./onboarding-claims-2026-09-13/human-review.md) is prepared but not completed.

## Validation and cost

- 3,275 unit/integration tests across 323 files passed. The production build/TypeScript passed. Changed-file lint passed with two pre-existing unused-argument warnings in the pipeline test. Whitespace checks passed.
- The onboarding browser regression passed 1/1, including a saved partial source-check state that stays visible after reload, with its flagged text. This fixture browser test does not measure live model quality or latency.
- The six final provider replays recorded approximately $2.65 in claim-check costs. Original-article checks recorded approximately $0.35–$0.56 each, in addition to writing and existing review. All development runs in this pass recorded approximately $5.27. These are recorded model estimates, not invoice totals.
- Individual final-run calls ranged from roughly 4 to 60 seconds; calls ran concurrently. Their summed duration is not user wait time. The complete hosted onboarding latency remains unmeasured.
- No production database change, publication, payment, merge or deployment occurred. The PR remains a draft.

The next release decision needs an independent reader to assess complete articles and the first topic choices, plus measured hosted latency. The new mechanism makes real defects easier to find and inspect; it does not justify calling the first draft consistently good enough yet.
