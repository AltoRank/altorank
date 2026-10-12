# Contributing to AltoRank

Issues and pull requests are welcome. The [README](README.md#contributing)
lists the two things that get a patch rejected however good the code is: a way
to publish that no person is accountable for, and a claim the repository
cannot support. This file covers the rest.

## Before you send a patch

1. **Never render an unknown as zero.** A number nobody measured, displayed as a
   measurement, is a fabricated claim even when no human typed it. Use
   `number | null`, render an em dash, and average only over rows that have a
   value.
2. **One implementation per behaviour.** Generation lives in
   `lib/content/generate.ts`; the streaming route and the cron both call it.
   Resist the second copy.
3. **An account is not a workspace.** RLS stops one customer reading another's
   data and nothing more; every read a page renders must also name its
   workspace. [AGENTS.md](AGENTS.md) explains why, and the tests in
   `apps/web/lib/queries/__tests__/workspace-scope*.test.ts` fail CI when a
   query forgets.

`npm run test` runs the unit tier (mocks only, no services needed). The db
tier, `npm run test:db`, runs against a local Supabase only.

## The marketing site

The marketing site (altorank.co) lives in its own private repository,
`AltoRank/altorank-marketing`. It moved out of this tree on 2026-09-06 so the
product stays open while positioning and pricing copy do not. Nothing here
imports it; the two are coupled only by the plan limits noted in
`apps/web/lib/stripe.ts` and `apps/web/lib/billing/quota.ts`, which must be
changed in both places together.
