# Onboarding topic qualification and trial gate

Based on main `16111d811549b93a0e2b6528fb9a99096dc104bc` (PRs #208–#213). Rechecked main while finishing; no newer merge was present.

## Resulting flow

1. Confirm offerings, audiences, buying jobs, supported differences, exclusions, market and conversion page. Read product/pricing/about text alongside the homepage. Infer direct competitors only when the supplied site evidence supports them.
2. Discover a diverse candidate pool. Own and competitor Labs rankings use organic results, the chosen market and organic position; retain provider intent and ranking URL. Keep unknown measurements unknown. Allow evaluative brand queries and low-volume buying jobs.
3. Require an affirmative buyer verdict for every accepted discovery candidate. Judge in bounded batches and retry omitted decisions once. Report coverage; an unavailable judge cannot report successful qualification.
4. Before scheduling, qualify at most 15 uncached candidates against live organic SERPs. Require an article-compatible format, explicit buyer/offering/angle, and at least two exact observed editorial result URLs. Missing evidence stays pending. Existing own ranking URLs become update candidates. Cluster overlapping SERPs within a batch and against currently qualified planned/written keywords in that workspace.
5. Show up to five explained topic briefs. Carry the chosen angle and buying job into the writer. Write one draft and expose its full text before card entry.
6. Show the actual completed-draft count and chosen monthly/yearly renewal price. Failed/empty drafts offer retry; non-owners get owner guidance. A completed checkout waits visibly for the account entitlement to match the owned Stripe session's subscription.

Qualifications are versioned against a stable fingerprint of the product and market. Accepted/rejected evidence lasts 30 days; transient pending decisions last 15 minutes. Normal list rendering reads cached evidence. Scheduling and unattended writing enforce current qualification, including for old keyword rows and top-ups. Explicit manual writing remains a user decision.

## DataForSEO mechanism

The relevant endpoints remain Labs `ranked_keywords/live`, `keyword_overview/live`, and `keyword_suggestions/live`. The precision change is the buyer and editorial qualification using `/serp/google/organic/live/advanced` before the calendar is written. Keyword volume, a competitor's ranking and a commercial intent label are not sufficient proof of a blog opportunity.

## Validation

- 3,203 unit tests across 309 files pass, including missing buyer verdicts, locale/organic ranking, evidence validation, semantic overlap, scheduling refusal, unknown metrics, checkout ownership/activation and durable checkout reuse.
- Next.js production build passes. Changed-file ESLint has no new findings; an existing `set-state-in-effect` error in `proposal-table.tsx` and two existing unused test parameters remain.
- Real local Supabase/browser fixture: eight planned entries plus one ready article displays one ready article; its full text is readable before trial. An editor sees owner guidance. A draft from another workspace is 404. An error draft gets no completed count or trial CTA. Retrying an error draft now succeeds through the actual onboarding worker and yields a readable preview.
- The browser fixture uses deterministic generation/search substitutes; its article prose is not a quality benchmark. Fixture topic approval requires E2E_STUBS, a reserved test domain and a loopback database.
- Two concurrent real local database claims return the same checkout attempt and frozen parameters. Tests separately cover Stripe request idempotency and delayed entitlement.
- Live Anthropic/DataForSEO benchmark: five synthetic business profiles, three curated queries each, English/US and Italian/Italy. Seven queries qualified, eight rejected. All five obvious unrelated queries were rejected. A packing app was rejected as a substitute for ShipStation's shipping/carrier job; two product/service-oriented queries were rejected as blog targets. An obsolete year found in an earlier run led to the evergreen-headline guard. Detailed sanitized evidence: [benchmark JSON](onboarding-topic-benchmark-2026-09-11.json).

This small sample validates the qualification path, not acquisition performance, all discovery endpoints end to end, or finished production article quality. Model classification remains probabilistic; the salon how-to rejection in the sample is conservative and its explanation is inconsistent about article count. The system intentionally leaves uncertain topics out, and should be calibrated against reviewed customer examples over time.

## Existing workspaces

Inspection is read-only by default:

```sh
cd apps/web
npx tsx --env-file=.env.local scripts/requalify-topics.ts --workspace=WORKSPACE_UUID
```

Add `--apply` to buy fresh qualification for up to 15 existing `new`/`stored` rows. Use `--offset=15` for the next stable page. This writes evidence only; it does not delete keywords, change statuses or instructions, alter calendars, or rewrite existing articles. Confirm the selected environment and inspect the resulting report before making editorial changes. No production cleanup has been run as part of this change.

## Release requirements and remaining verification

Apply migrations **088_topic_qualification.sql** and **089_checkout_attempts.sql** before deploying the application. Both were applied to the local database; production has not been migrated or deployed. Checkout reservation storage and its claim function are service-role-only.

Hosted Stripe sandbox verification remains outstanding: card entry, selected price/tax, actual trial creation, cancellation, delayed/duplicate webhooks, repeat starts, trial expiry and failed payment. No usable Stripe test key is present in this environment. Local fixtures and mocked Stripe tests do not prove those external steps. The activation screen waits for the existing webhook to establish entitlement and never unlocks from a query parameter.

If Stripe created a session but its ID could not be persisted, immediate retries reuse the durable idempotency key. A prolonged outage beyond Stripe's idempotency retention may require operator reconciliation; the reservation is deliberately not discarded solely because local time elapsed.
