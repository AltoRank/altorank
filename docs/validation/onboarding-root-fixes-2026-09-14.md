# Onboarding root fixes — 14 September 2026

This follows the [readiness assessment](./onboarding-readiness-2026-09-14.md). The required experience is a useful, supported choice and a complete first draft before the trial gate, followed by the same draft and other supported first-month articles in the dashboard. Mechanical completion and useful prose are assessed separately.

## Mechanism

1. Keyword qualification requires article results for the confirmed buyer and task. The final headline review must identify two relevant results for that exact task. Qualification policy version 8 invalidates earlier cached decisions and overly broad topic groupings.
2. First-choice discovery defers the full site audit and owner interview questions. Nested research stages share a 240-second invocation deadline; the worker database transport has a 15-second per-query limit and a 285-second absolute limit, preserving time for handoff. Progress writes coalesce to the latest snapshot. Discovery saves its candidates into a private, leased source-preparation queue. A separate request checks at most five candidates, two at a time, with a shared 30-call/180-second budget. Only choices with complete source preparation become selectable.
3. A DOM parser extracts text and observed links before clipping excerpts. It handles self-closing elements in server-rendered pages, and document-shell class names cannot hide the entire body. Fetch outcomes distinguish unavailable, unsupported and insufficient content, and preserve truncation diagnostics. Short routing pages can lead to substantive help pages without counting as factual evidence. The collector caps attempted reads, including failures, at twelve.
4. One scope review removes optional additions and explicitly checks whether retained questions cover the approved headline and buying job. Named headline criteria and explicit user instructions bind that review; qualification explanations and ordinary adjacent criteria cannot expand the promise. Editorial synthesis is not an extra factual research requirement. Pruning also discards earlier link choices. Subsequent research uses the frozen questions and observed links; it cannot invent a narrower headline or a different buyer.
5. Private prepared packets are scoped to the workspace, keyword, business focus, task, locale, instructions and source identity. Ready packets last 24 hours; unavailable/insufficient packets last five minutes. Explicit bounded retries may refresh unavailable checks. The choice and writer use the same packet receipt; stale or changed packets require refresh before writing.
6. First-month source work and writing use separate worker invocations. Preparing evidence does not consume a writing attempt or article quota. Each new write checks the current account allowance; recovering an article already saved can finish even when that write exhausted the allowance.
7. Claim review revisits suspicious empty claim lists within its existing recovery-call budget. Unresolved extraction remains incomplete. Ordinary advice and hypothetical examples can receive an explicit nonfactual classification. This supplement uses English surface cues and does not establish complete multilingual assertion recall.
8. Failed empty generation rows no longer suppress their keywords as existing content. Substantive drafts and approved content with publication failures continue to count as coverage.
9. The browser follows the selected run ID after a choice. A fast completed draft cannot cause its progress screen to create another discovery run. An expired source packet offers a working refresh action without consuming the free draft.

## Storage and recovery

Migration 094 adds service-only `draft_preparations` and `onboarding_choice_checks`. RLS and explicit client privilege revocation protect the private packets. Claim and finish RPCs serialize transitions, reject stale leases and changed candidates, validate the saved receipt, and remove only the unsuccessful run's unwritten provisional entries. Two interrupted attempts close as partial. Existing articles and unrelated/scheduled entries survive cleanup.

Only migration 094 was applied to the existing local development database. The shared stack was not reset or restarted. Actual SQL regressions ran in rolled-back transactions and checked client denial, service access, exclusive active claims, stale/replaced tokens, candidate and receipt mismatches, scoped cleanup and exhausted attempts. Claim exclusivity was tested with sequential SQL calls under the row-lock implementation, not a multi-connection load test. Existing local migration-ledger drift was documented rather than replaying older migrations.

## Validation record

- Broad unit run before the final polling/receipt regressions: 3,515 tests passed across 337 files. TypeScript, changed-file lint and production build passed at that checkpoint.
- The gate-enabled browser flow passed onboarding, preview, signed fixture activation, first-month continuation and dashboard preservation. Actual Stripe card entry is not part of this fixture lane.
- The new expired-source browser case exposed a fast-completion race in the standard inline lane. Its regression now delays delivery of the real choose response until the draft is done; the fixed screen follows the same run instead of creating another. The focused rerun passed without retries.
- The initial broad browser run passed 17 of 19 cases. It exposed the above race and a separate 60-second linking-test timeout on the loaded local host. Neither failed attempt is counted as a passing suite.
- Independent code review found and prompted fixes for final-quota recovery, immediate unavailable-source retries and source-packet replacement between choice and writing.

At `c29daee`, all 3,531 unit tests across 339 files passed, TypeScript passed, and the final three gate-enabled browser tests passed without retries. [CI 34848353758](https://github.com/AltoRank/altorank/actions/runs/34848353758) passed the build, standard browser suite and trial-gate lane. The separate `no-mistakes` wrapper did not complete: its Claude review process exited with status 1 before returning findings. Independent review and direct checks are recorded above; they are not a wrapper pass.

## Fresh diagnostic cohort at c29daee

The eight-case manifest was fixed before execution. The run was intentionally stopped after the first three cases exposed shared mechanism defects; the remaining five were not evaluated. Bellroy's next-case bookkeeping created an empty local account at the stop boundary, with no workspace, focus stage or provider call. This is a failed diagnostic cohort, not a release quality rate.

| Case | Outcome | Total / discovery / preparation | Recorded provider cost | Quota |
| --- | --- | --- | --- | --- |
| Basecamp | No ready topic | 336.1 / 312.1 / 8.8 seconds | $0.519526 | 0 → 0 |
| Brevo | No ready topic | 223.5 / 204.0 / 7.3 seconds | $0.583206 | 0 → 0 |
| Allbirds | No ready topic | 207.4 / 165.1 / 27.3 seconds | $0.899792 | 0 → 0 |

No draft was produced. The known recorded total is $2.002524. Accounting-deadline warnings mean that spend may be understated. The shared local host was heavily loaded; these timings are not production latency estimates. Source and model receipts remained available, so the semantic and extraction failures can be investigated independently of that contention.

Basecamp and Brevo reached a scope reviewer that added unpromised requirements. Brevo's initial HTML also exposed a self-closing iframe parsing problem, and SELF's page exposed document-shell classes being mistaken for navigation. Allbirds had useful product evidence, but its source brief mixed zero-based and one-based references and treated an explanation as a vendor comparison. The corrected raw brief uses explicit fact identifiers, passes the actual answer form, and retains numeric references only after server validation. Vendor evidence, plan scope and readiness requirements remain enforced.

A focused live Allbirds replay against exactly the saved sources and plan then prepared 11 traceable facts and passed all three independent readiness questions in 17.6 seconds, at a known model cost of $0.079515. This diagnoses the correction; it is not a new discovery run or an assessment of generated prose. A paired scope replay accepted four of four bounded positive cases, while all three explicit missing-action/cost/instruction controls remained unavailable. The old prompt accepted one of the four repeated positives. The corrected grouping retained both Basecamp tasks. These 12 model calls cost $0.07176; this small calibration exercise is not evidence of a population-level success rate. The settled correction passed all 3,580 tests across 342 files and TypeScript. Changed-file lint had no errors (five unused-parameter warnings in test helpers). Final handoff regressions require acknowledgment of the latest saved plan; database preflight failures return a retryable response without closing an uncertain claim. The source worker has a fresh transport deadline and includes preflight reads in its research clock. Unknown committed claims retain the existing stale-run recovery. Browser checks and the fresh corrected cohort are recorded when complete. Raw model responses, provider receipts and generated candidates remain outside Git in the protected `onboarding-evidence-validation` directory. Earlier development outputs are not pooled into a release success rate.

## Release boundary

The PR remains a draft until current-revision validation and first-draft quality assessment are complete. These mechanisms make supported choices and failures more trustworthy; a model declaring coverage complete does not prove that every assertion is correct. Production migrations, deployment and post-deployment checks are separate from the local validation recorded here.
