# Onboarding production-readiness work — 13 September 2026

This work addresses the failures in the [fresh Cal.com flow](./onboarding-live-flow-2026-09-13.md). Release approval depends on the fresh-run results below; passing code checks alone does not establish content quality.

## Changes

- Successfully retrieved publisher pages now survive the internal citation check. Quotation-only profile evidence does not establish current URL reachability.
- Approved source quotations reach both first-draft reviewers with their source URL. Relevant product pages are read again, and large script-heavy pages yield main-body evidence rather than navigation-only excerpts.
- The evidence planner can retrieve six additional observed references, prioritizing missing competitor pricing needed by the selected task. No guessed URLs are allowed. Input size, call concurrency and deadlines remain bounded.
- Writing instructions require comparisons to evaluate the same criteria across the promised options. Review explicitly flags an unfulfilled comparison or a mostly empty pricing table. Automatic rewriting remains disabled.
- The confirmed buyer and offering constrain topic eligibility. Final approval requires an explicit focus decision; missing decisions remain pending, mismatches are rejected, and earlier cached qualification is invalidated.

## Checks completed before the live run

Production build and TypeScript passed. Changed-file lint passed. The full suite passed 3,283 tests across 324 files; the additional reviewer-evidence handoff test passed separately (3,284 tests across 325 files in total).

The existing task/offer regression passed 20/20 live-provider checks. New focused cases passed 6/6 after making the required response shape explicit: reject healthcare drift for a startup buyer, accept team payment scheduling, and accept healthcare when explicitly selected. An earlier run returned 5/6 because one supported response omitted its focus decision; it was correctly kept unavailable.

A fresh-source review of the old Cal.com article now identifies the missing competitor prices and the promised three-tool comparison that only calculates Cal.com's cost. An old-draft claim replay remained partial and found new source mismatches; it is not a quality pass. Its evidence packet differed from the original, so findings cannot be interpreted as a controlled precision comparison.

## Fresh flow and release decision

A new local account is running the production build with real Anthropic, DataForSEO and public retrieval. Final flow results and the resulting release decision will be recorded after completion. No merge, deployment, payment or publication is authorized by this report.
