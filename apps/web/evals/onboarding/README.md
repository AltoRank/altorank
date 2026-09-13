# First-onboarding quality evaluations

These are executable development checks for the keyword-to-first-draft experience. They complement the fixture browser suite and unit tests. They do not establish conversion, publication readiness, discovery recall, or independent human approval.

## Datasets and labels

- `claims.json`: 16 synthetic passage cases, derived from failure classes seen in four live businesses. Eight development cases and eight initially reserved cases, with correct/incorrect minimal pairs. Includes Italian, plan limits, conditional advice, attribution, repetition and unsupported inferences.
- `full-drafts.json`: three known material errors in saved complete drafts. Passage matching is only a locator; the finding reason must be checked manually against the labelled defect.
- `topics.json`: 13 explicit business/task boundaries, including Italian. Tests the final task/offer relationship and confirmed buyer focus, not keyword discovery or ranking. `--case-prefix=confirmed-focus` selects the three focused cases. An unavailable result is never counted as a correct rejection.
- Labels are evaluator-authored, not independent human labels. A quoted fictional source is the test's ground truth; it is not real-world advice. No expected label is sent to the model.

The original passage grading incorrectly treated a correctly detected error under another category as both a miss and a false positive. Current grading measures detection independently and reports category errors separately. Development excerpt briefs were also narrowed so a two-step excerpt was not incorrectly asked to fulfill a whole buying guide. The discarded initial run is documented in the validation report.

The reserved set was used during model selection. Final reruns on it are regression checks, not a fresh independent holdout. Add genuinely unseen businesses and human labels before making general quality claims.

## Run the passage comparison

From `apps/web`, using a separate checkout of the original implementation:

```sh
npx tsx scripts/onboarding-eval.ts --provider-env=/path/to/provider.env --baseline-checkout=/path/to/baseline --out=/tmp/onboarding-eval --split=development --repeats=2
```

Variants are `baseline` (original reviewer), `model` (original prompt with the editorial model), `prompt` (current reviewer with the structured model), and `combined` (current reviewer and editorial route). Current structured-output validation and reasoning settings are part of the combined route; this is not a pure model ablation. Results record models, status, usage, cost, latency and prompt hashes where available. Invalid or truncated responses fail the case.

```sh
npx tsx scripts/onboarding-eval.ts --provider-env=/path/to/provider.env --baseline-checkout=/path/to/baseline --out=/tmp/onboarding-topics --topics --topic-tier=editorial
```

Topic checks run twice per case. Compare unsupported vs unavailable explicitly. Passing these obvious offering boundaries does not establish that the first three recommendations are optimal.

## Replay a full saved draft

```sh
npx tsx scripts/onboarding-output-eval.ts --provider-env=/path/to/provider.env --report=/path/to/saved-report.json --out=/tmp/onboarding-output
```

Supports the pipeline report and the saved full-browser report formats. It fetches bounded public source pages, reviews the saved draft, attempts the experimental revision, and saves the candidate. `--write` additionally generates a new draft with the saved business/task/research and new evidence. This is a writer/reviewer replay, not the entire production enrichment, image, SEO-check, database, UI or payment flow.

Optional `--cached-evidence=/path/to/results.json` fixes the evidence packet; `--draft-html=/path/to/article.html` fixes a chosen candidate; `--review-only` skips revision; `--evidence-only` stops after collection. `--reasoning=medium` explicitly requests the measured bounded-reasoning path. No integration or database credentials are loaded. The scripts make real billable model calls and public reads, but never publish, send email or start checkout. Raw source packets and model responses stay in the chosen local output directory; commit sanitized summaries only.

## Production settings and acceptance

`ANTHROPIC_MODEL_EDITORIAL` independently overrides final task checks, review and experimental revision; it falls back to the general model override or the content default. `ANTHROPIC_MODEL_STRUCTURED` remains the short extraction override. Earlier simulation scripts incorrectly loaded `ANTHROPIC_STRUCTURED_MODEL`; that is fixed.

Full-article editorial calls use medium adaptive reasoning on supported Sonnet/Opus model IDs, a 60-second deadline and schema-constrained JSON. Short final-topic checks disable thinking. `ANTHROPIC_EDITORIAL_REASONING=disabled` is available for controlled comparisons. The helper rejects truncation, reads text after thinking blocks, and distinguishes deadline, schema and incomplete-check failures. The review receives only the approved task fields, not the entire nested SERP and qualification trace.

The experimental reviser handles up to six paragraphs/list items/table cells, preserves container markup and existing link destinations, and requires explicit resolution of original material concerns with no remaining/new material findings. Editorial findings remain visible. This is a model judgment, not proof of correctness.

**Automatic revision is disabled in production generation.** A real accepted correction retained a material comparison error and changed acceptable wording. The offline reviser remains available for calibration; a lower finding count or an `accepted` status is not the release metric.

The product bar remains: relevant first choices, a useful answer to the chosen task, no material unsupported claims found in independent review, and only light editing needed. Measure latency/cost on stable infrastructure and conversion with actual users separately.

## Claim-level full-article checks

Use `onboarding-output-eval.ts` with `--claims-only` to run the bounded claim verifier instead of the whole-article review/revision. Combine it with `--cached-evidence` to hold sources fixed. `--draft-html` can select a controlled article. This makes real provider calls; it does not write to the database.

`full-draft-controls.json` records four evaluator-authored corrected passages in three complete saved articles. It is a development negative-control set, not human approval or a complete rewrite. The scorer requires a corrected passage to have been checked before absence of a flag can pass:

```sh
npx tsx scripts/onboarding-claim-score.ts --results=/tmp/onboarding-output/results.json --html=/tmp/original.html --out=/tmp/score.json --business=altorank
npx tsx scripts/onboarding-claim-score.ts --results=/tmp/control/results.json --html=/tmp/control.html --out=/tmp/control-score.json --business=altorank --control
```

Positive scores locate a finding; independently inspect its reason. Negative controls require checked-passage coverage and no flagged claim in that passage. Neither score is a whole-article factual grade. The implementation and results are in `docs/validation/onboarding-claims-2026-09-13.md` at the repository root.

## First-draft evidence and delivery regressions

The live Cal.com retest exposed stripped publisher citations, dropped capability evidence, an unfulfilled comparison promise and buyer-focus drift. Generation now admits successfully retrieved URLs to the internal citation check, shares approved source quotations with claim verification, and reads up to three product pages plus three search sources. One evidence-planning call can select up to six additional observed references, prioritizing missing competitor pricing when the task needs it. Previously observed quotation-only sources do not establish current URL reachability.

Page reads remain bounded to six seconds and two megabytes, extract the main content before truncating text, and retain useful navigation references such as pricing pages. Claim packets are bounded to 20 sources, 13,500 characters per source and 120,000 characters total; call/concurrency/deadline ceilings are unchanged. The larger packet accommodates fuller comparison evidence and at most eight short approved quotations, with a corresponding model-cost tradeoff.

Final topic validation requires an explicit buyer/offer focus decision when that focus is supplied. Unsupported tasks are rejected; missing decisions remain pending. Opportunity version 6 invalidates pre-focus cached qualification. Review checks whether section promises actually deliver their stated comparison; a single publisher calculation cannot satisfy a three-tool worked example. These checks expose failures; automatic rewriting remains disabled.
