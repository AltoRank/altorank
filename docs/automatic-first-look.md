# Automatic first article: gated implementation

The new onboarding path reads the site, prepares the business profile, selects a first article, and opens the existing title-and-outline trial screen. A clear site needs no competitor, keyword selection, or Search Console connection. A person can interrupt preparation to correct the main offering; an unclear profile asks that one question. Inferred profile fields are not stamped as owner-confirmed.

## Rollout

Disabled by default. Set the server environment variable `AUTOMATIC_FIRST_LOOK_WORKSPACES` to a comma-separated list of explicitly selected workspace IDs. Both the page and pipeline use this allowlist. There is no wildcard. Removing an ID restores the existing path for future runs; saved articles and evidence remain.

This is a review build, not a production rollout recommendation. No database migration is required. The new selection evidence lives in the existing keyword opportunity JSON, and run outcomes use the existing persisted onboarding lifecycle. Authentication, spend entitlement, the one-article trial hold, and worker dispatch remain in place.

## What selection does

1. Read existing pages before selecting a topic. Propose at most six queries from the site's offerings, with a verbatim supporting passage for each service.
2. Validate that the offering is in the profile and the passage is in the actual site read. If the owner supplied a focus, restrict proposals to that offering.
3. Ask a separate reviewer whether the full service is offered, the query helps a concrete buyer decision, existing content covers it, and another proposal answers the same decision.
4. Fetch keyword facts in one batch. Missing volume remains unknown in every market. Existing Search Console query impressions are optional enrichment.
5. Run the existing live buyer and SERP qualification, with a stricter requirement: the second results read must be usable and retain buyer intent. Audience-level, lower-confidence, floor-promoted, duplicate and existing-page topics cannot be the first article.
6. Rank eligible topics by primary service, supporting search evidence, existing impressions, then demand. Unknown demand receives a neutral prior, rather than being treated as zero or always placed below measured terms. These are initial heuristics to evaluate, not calibrated predictions.
7. Give the planner the explicit shortlist and schedule one article. If the list is empty, or the planner cannot place it, do not fall back to the general queue. Save the selection rationale with the chosen topic and show it on the first-article card.

Variants share a stable ID derived from normalized offering and decision category. A semantic review also checks overlap across different offerings, followed by the existing SERP/word overlap check. This intentionally produces a small first-look set; it does not replace the paid content strategy.

## Validation so far

- The complete unit suite passes: 4,634 tests across 441 files at this revision, including new service-evidence, missing-data, duplicate, ranking, workspace-isolation, strict-shortlist, automatic-profile and trial-screen tests.
- Guarded lint and TypeScript checks pass. The wizard has one pre-existing exhaustive-dependencies warning outside guarded lint.
- The production Next.js build passes. In-browser component checks with simulated server actions cover automatic continuation, a missing-profile clarification, pausing for an optional correction, and expanding the rationale. They do not replace a full browser run against the database.
- A small live check on a public software consultancy exercised site/profile reading, candidate generation, independent review, and two live SERPs. It found an audience-level approval that the strict selector now excludes. Rechecking the captured proposals and SERPs selected an MVP-agency buyer guide.
- That live check did **not** crawl the full site's existing coverage, generate a body, or establish a conversion improvement. The revised prompt was checked on the same captured case; that is regression evidence, not a fresh holdout.

## Before enabling for customers

Run fresh, representative sites through the full pipeline, with the same writer-source, page-type and budget fixes intended for release. Review the resulting articles for actual service fit, factual support, originality, existing coverage, and a useful next step for the reader. Measure topic acceptance, edit burden, completion time, cost, and trial progression.

The existing crawler is bounded and the semantic coverage review currently stops for more than 200 known owners; it cannot claim an exhaustive coverage audit. Model review can still make semantic mistakes even when the quote is real. The current spend checks are between calls, not atomic reservations; the budget-reservation change remains a rollout dependency.

The preview's optional outline swap and dedicated editorial-review queue with bounded automatic retries are separate follow-up work. This implementation preserves the existing persistent failure/empty-plan and retry machinery and withholds the automatic path's trial offer until an article exists. It does not promise a human response time or generate an extra pre-trial article.
