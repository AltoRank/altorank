# First-onboarding calibration — 13 September 2026

**Keyword task checks improved on the labelled cases. Full-draft factual quality is still not dependable. Automatic model rewriting is disabled in production generation; PR 215 remains a draft.**

This continues the [first-onboarding assessment](./onboarding-improvements-2026-09-13.md), covering keyword identification and the chosen first draft before the trial gate. The route, evidence and evaluation changes below are implemented. They do not establish that the first draft is good enough for release or that onboarding conversion improves.

## What changed

- Final topic/offer checks have a separate editorial model route and distinguish a supported task, an unsupported task and an unavailable check. Explicit rejection JSON replaces ambiguous null-filled responses. Keyword qualification also fixes an array-callback bug: an array index was accidentally passed as the page character limit, leaving the first evidence page empty.
- The writer receives a task-specific evidence plan for comparisons, procedures or explanations. One planning call can choose up to three additional observed links, with bounded reads and existing public-fetch safeguards. Writer and reviewer share the resulting excerpts. Missing evidence remains unknown; instructions require supported steps and limits, or buyer evaluation criteria when named-product comparisons lack evidence.
- The review receives only approved task fields instead of nested SERP/qualification traces. Editorial model calls use schema-constrained JSON, explicit failure reasons, truncation handling, all returned text blocks, and recorded model/cost/latency metadata. Full-article calls use medium adaptive reasoning on supported models with a 60-second deadline; final-topic checks disable thinking. The shared research budget can cap that deadline further.
- `ANTHROPIC_MODEL_EDITORIAL` independently selects the editorial model, falling back to the general override or content default. Extraction keeps the structured route. The simulation scripts now load the actual model override variable names.
- The offline reviser supports bounded paragraph, list-item and table-cell edits, preserves markup and existing link destinations, and requires explicit resolution of every original material concern plus no new material findings. **Those safeguards are insufficient to establish correctness, so production generation no longer invokes this reviser.** Existing exact-duplicate paragraph cleanup and approved-title enforcement remain.
- Reproducible passage, topic and saved full-draft evaluation scripts and labelled cases are included. Raw provider responses are available only to an explicitly enabled offline observer; production metadata contains no response text.

## Measured results

All experiments used real provider calls. Labels are evaluator-authored, not independent human labels. Each small case ran twice; repeated runs are not independent cases.

| Evaluation | Result | Interpretation |
| --- | --- | --- |
| Original route, development passages | 13/16 runs passed | Three labelled issues missed, including one unavailable check. |
| Original prompt with editorial model, development | 16/16 | Model routing helped these eight cases. |
| Aggressive revised prompt, initially reserved passages | 14/16 with structured model; 13/16 with editorial model | Added false positives. This prompt was not promoted. |
| Original prompt with editorial model, initially reserved passages | 16/16 | Supported retaining the original prompt with targeted validation changes. |
| Selected route regression, development and formerly reserved passages | 32/32 runs passed | Sixteen cases, each repeated twice. Two category mismatches remain on the formerly reserved set. |
| Final task/offer boundary checks | 20/20 runs passed | Ten explicit boundaries, including Italian, repeated twice. This does not measure keyword discovery, ranking or recommendation precision. |

The initially reserved passages were used during selection. Final reruns are regression checks, not an independent holdout. An initial run also had a scoring error that conflated wrong categories with missed findings, and overly broad development briefs; it was discarded before the comparisons above. The selected route includes model, response-schema and reasoning changes, so it is not a pure model ablation.

### Full articles expose the remaining blocker

| Saved full draft | Directly observed result |
| --- | --- |
| AltoRank | Medium reasoning caught the contradiction about a named tool needing a manually written first draft in one replay. The final compact/schema replay flagged a different assertion in the same paragraph and accepted a correction that still preserved the contradiction. |
| Beardbrand | The final compact/schema review reported no findings despite the unsupported minimum two-week application routine. |
| Pimlico | The final review reported no findings despite the unsupported property-boundary inference. |
| Plausible | The replay still produced disputed or incorrect flags and retained the original. It did not establish a dependable correction. |

A finding matching a long paragraph does not prove detection of the labelled error: its reason must identify the actual defect. Likewise, an accepted revision or a lower finding count is not a quality pass. The full-draft labels and replay script explicitly preserve this need for manual checking.

Earlier writer replays for AltoRank, Beardbrand and Pimlico used saved inputs and intermediate code. Some passages became more concrete, but unsupported claims and new reasoning errors remained. Those samples do not demonstrate final-code improvement across complete onboarding runs. Additional evidence selection also sometimes chose weak publisher or promotional pages; complete first-party coverage is not established.

[Sanitized experiment results](./onboarding-calibration-2026-09-13/results.json) include the comparison metrics, full-draft findings and manual known-error judgments. Original drafts are in the [previous report](./onboarding-improvements-2026-09-13.md). [Evaluation commands and datasets](../../apps/web/evals/onboarding/README.md) explain reproduction and limitations.

## Engineering validation and cost

- Final unit/integration suite: 3,258 tests across 321 files. Production Next.js build/TypeScript, changed-file ESLint and diff whitespace checks passed.
- The targeted onboarding browser regression passed 1/1. The previous implementation passed the complete 17-test browser suite and a live Plausible journey with full preview before trial; this calibration pass did not repeat four fresh browser/provider journeys.
- Recorded model cost across this calibration's experiment files was approximately $6.78. This is diagnostic usage, not an invoice total or a per-onboarding estimate. The selected passage regression cost about $0.234 across 32 runs. Source planning and stronger reviews add calls and latency; no stable hosted latency or conversion benchmark was performed.
- Model experiments used public reads and saved inputs, with no publication, payment or production database changes. Actual Stripe checkout, webhooks and entitlement transitions remain untested. No merge or deployment occurred.

## What is still needed

The next quality change should verify individual decision-relevant claims against specific source passages, preserve restrictions and exceptions, and test the resulting article in full context. Comparison claims need the named vendor's own evidence; procedural conclusions must not exceed the instructions they cite. Whole-article self-review is currently missing these distinctions even when isolated examples pass.

Evaluate final writer output and corrections against human-labelled full articles from unseen businesses, scoring the first three topic choices separately from draft correctness and usefulness. Keep automatic rewriting disabled until it fixes known defects without damaging supported material and passes that independent review. There is no missing product direction blocking this work; the unresolved issue is demonstrated output quality.
