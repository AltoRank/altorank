# Onboarding root fixes — 14 September 2026

This follows the [readiness assessment](./onboarding-readiness-2026-09-14.md). The required experience is a useful, supported choice and a complete first draft before the trial gate, followed by the same draft and other supported first-month articles in the dashboard. Mechanical completion and useful prose are assessed separately.

## Mechanism

1. Keyword qualification requires article results for the confirmed buyer and task. The final headline review must identify two relevant results for that exact task. Qualification policy version 7 invalidates earlier cached decisions.
2. Discovery saves its candidates into a private, leased source-preparation queue. A separate request checks at most five candidates, two at a time, with a shared 30-call/180-second budget. Only choices with complete source preparation become selectable.
3. A DOM parser extracts text and observed links before clipping excerpts. Fetch outcomes distinguish unavailable, unsupported and insufficient content, and preserve truncation diagnostics. Short routing pages can lead to substantive help pages without counting as factual evidence. The collector caps attempted reads, including failures, at twelve.
4. One scope review removes optional additions and explicitly checks whether retained questions cover the approved headline and buying job. Pruning also discards earlier link choices. Subsequent research uses the frozen questions and observed links; it cannot invent a narrower headline or a different buyer.
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

Final revision checks and the fresh real-provider cohort are recorded below when completed. Raw model responses, provider receipts and generated candidates remain outside Git in the protected `onboarding-evidence-validation` directory. Earlier development outputs are not pooled into a release success rate.

## Release boundary

The PR remains a draft until current-revision validation and first-draft quality assessment are complete. These mechanisms make supported choices and failures more trustworthy; a model declaring coverage complete does not prove that every assertion is correct. Production migrations, deployment and post-deployment checks are separate from the local validation recorded here.
