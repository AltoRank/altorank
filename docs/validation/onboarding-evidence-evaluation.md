# Onboarding mechanism evaluation — 13 September 2026

Implementation baseline: merged PR 214 (`79795f6`). This change implements focused buyer/offering selection, source provenance and broader discovery, bounded auditable qualification, task-preserving briefs, capability-aware output checks, and a persisted choice before the first draft. Technical audits and voice preparation no longer delay the first topic choice. Two migrations are required: 090 and 091.

## What the checks establish

- Deterministic contracts cover zero difficulty, volume 10, both Labs expansion response shapes, provider dates and secondary intent, request isolation and limits, own-page task checks, continuation beyond 12 candidates, the 25-candidate ceiling, observed result references, and incomplete evidence.
- The browser journey asserts zero drafts before selection, saved choices after reload, one selected draft in review, and its calendar link. The broader browser suite covers workspace switching and approval gates.
- `apps/web/scripts/onboarding-quality.ts` uses production `analyseDomain` and `recommendKeywords` for fresh runs. Its controlled replay option preserves candidate order and is explicitly labelled as a replay. Provider keys are allowlisted; persistence is refused unless Supabase is on loopback. Payment, email, publishing and image generation are excluded.
- The first live development run revealed that a positive editorial judgement could still turn a selection query into a publisher-positioning essay. The independent task editor was added in response. The server now attaches observed URLs/quotations by result index and field, avoiding model transcription errors without accepting invented sources. Earlier cached briefs are invalidated by opportunity version 4.

A passing fixture is not a human quality label. A live run on AltoRank is development evidence, not proof of general quality or higher conversion.

## Held-out evaluation before claiming broad improvement

Keep AltoRank, Qasimcode and FitSuite as development cases. Recruit eight additional businesses across: local services, appointment software, ecommerce operations, regulated professional services, a niche consumer product, an editorial publisher, a multilingual B2B product, and an early-stage product with little search data. Freeze their confirmed profiles, language/market and source responses before comparing revisions.

For each business, have a reviewer label at least 25 candidates without seeing the implementation's verdict: buyer fit, offering relationship, editorial suitability, existing-page overlap, search-task preservation, and useful conversion path. Review all proposed briefs and one completed draft. Record both accepted bad candidates and rejected good candidates; distinguish unknown evidence from a negative judgement.

Report precision and recall per business and in aggregate, three-to-five distinct briefs where supported, time to first useful result, time to chosen draft, provider calls and cost, repeated definitions/conclusions, unsupported product or qualitative claims, and headline preservation. Never fill the calendar to meet a count. Publish labels and disagreement notes alongside metrics.

## Release checks still requiring a hosted environment

Use an isolated hosted Stripe sandbox to verify a preview can be read before checkout, a successful trial unlocks the correct workspace, cancelled checkout preserves the draft, failed payment does not unlock paid actions, and webhook retries are idempotent. Local fixture browser tests intentionally have no Stripe credentials and do not establish these claims.

Measure onboarding engagement and trial conversion after release; implementation and tests alone cannot prove that the experience converts better.

## Validation recorded for this branch

- 3,237 unit/integration tests passed across 317 files.
- All 17 local browser tests passed; onboarding and unreadable-site journeys passed again after the preview changes.
- Next.js production build and TypeScript passed. Changed-file lint has no errors; six existing warnings remain in touched files.
- Migrations 090 and 091 were applied transactionally to the existing local test stack. No production schema or deployment was changed.
- The sanitized live-case summary is in `onboarding-evidence-live-2026-09-13.json`: 36 stored candidates, 12 checked before the time limit, three distinct supported briefs, and one 1,881-word comparison draft. Recorded provider cost was $0.654, with no unknown-cost rows. This is one development case.

The sampled draft's review exposed false-positive claim flags and unsafe partial-sentence deletion. The final implementation preserves flagged prose for review, exposes findings in both preview and editor, and only automatically removes a whole paragraph repeated verbatim. It does not certify drafts as factually correct. This cleanup change is covered by regression tests; the recorded sample predates that final cleanup revision.

Apply both migrations before deploying the application. Keep the PR in draft until the hosted checkout checks and release review are complete.
