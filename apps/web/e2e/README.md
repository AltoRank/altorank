# End-to-end suite

Playwright drives the real dashboard against a real Next dev server and the
local Supabase. Server actions, the onboarding pipeline, RLS and every row the
product writes are exercised for real. The only things replaced are the paid,
slow, non-deterministic edges - the model, DataForSEO and fetches of customer
sites - and they are replaced at the entry points the product already treats as
fallible. Nothing in this suite spends money or leaves the machine.

## Run it

```
cd apps/web
supabase start                 # once; the CLI applies supabase/migrations
supabase status -o env         # copy API_URL / ANON_KEY / SERVICE_ROLE_KEY into
                               # .env.development.local as NEXT_PUBLIC_SUPABASE_URL,
                               # NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
npx playwright install chromium
npm run e2e                    # starts `next dev -p 3110` with E2E_STUBS=1 itself
npm run e2e:ui                 # the same, in the Playwright UI
```

For a fast loop keep the server up in one terminal - `npm run dev:e2e` - and
run `npm run e2e` in another; the runner reuses a server already on 3110.
**That server must have been started with `E2E_STUBS=1`** (which `dev:e2e`
does). A plain `next dev` on that port would let the onboarding spec reach
whatever providers your env has keys for.

The HTML report lands in `playwright-report/` (ignored by git); failures keep a
trace you can open with `npx playwright show-report`.

## Guardrails

- **Localhost only.** `e2e/fixtures/env.ts` loads the env the way `next dev`
  does and refuses to start if `NEXT_PUBLIC_SUPABASE_URL` or `E2E_BASE_URL`
  points anywhere but localhost. The suite creates and deletes users with the
  service role; the local database is the only one it may ever do that to.
- **No passwords.** Accounts are created through the GoTrue admin API without
  one, and the browser is signed in by visiting the app's own `/callback` with
  a magic-link `token_hash` minted by `generate_link`. The signup spec fills
  the password field with random bytes generated at runtime, because the form
  cannot be submitted without one; the server rejects the domain before it
  reads the field, and nothing is stored.
- **No spend.** The dev server is started with `E2E_STUBS=1` and with
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, the DataForSEO variables and
  `STRIPE_SECRET_KEY` blanked. Under the switch, `lib/seo/client.ts` reports
  credentials as present (so the keyword phase runs) and throws on any actual
  request, so a call that escapes the stubs fails loudly rather than quietly.
- **Unique accounts, cleaned up.** Every test gets its own
  `e2e+<tag>@altorank.test` user, agency and workspace(s); teardown deletes
  the agency (cascading every workspace row) and then the user, even when the
  test fails.
- **Nothing measured is invented.** Fixtures seed account structure only.
  `dr` and `traffic` stay null, the analysis stub writes keywords and nothing
  else, and the article stub runs through the real fact checker.

## Never touch a running stack with the supabase CLI

The suite talks to the local Supabase **only** through the already-running
containers. It must never run `supabase start`, `supabase stop`, `supabase db
reset` or `supabase migration` against a stack it did not itself provision.

This is not a style rule. This checkout's local Postgres is shared with other
agents. On 2026-09-04 the database container was OOM-killed with ten dev servers
running on one machine; a `supabase start` issued to recover it recreated the
volume **empty**, wiping every other agent's schema and data. Recovery meant
re-piping migrations by hand.

So:

- `playwright.config.ts` starts only `next dev` (never a database), and
  `e2e/fixtures/env.ts` **aborts before any server or row** if
  `E2E_BASE_URL` or `NEXT_PUBLIC_SUPABASE_URL` is not localhost.
- Apply migrations by piping the SQL files through
  `docker exec -i supabase_db_altorank psql -U postgres -d postgres`, never the
  CLI, when a running stack must be repaired.
- CI is the one place a fresh `supabase start` is correct, because the runner
  owns its own throwaway stack (see the `e2e` job in `.github/workflows/ci.yml`).

## The `E2E_STUBS` switch

One module, `lib/e2e/stubs.ts`, holds the fixtures. Six production call sites
check `e2eStubsEnabled()` (`process.env.E2E_STUBS === "1"`, read at call
time) and return the fixture instead:

| Entry point | Under the switch |
| --- | --- |
| `lib/onboarding/business-profile.ts` `inferBusinessProfileDetailed` | a profile for the domain (Italian / Italy) - or `unreadable` when the domain starts with `unreadable.` |
| `lib/onboarding/site-text.ts` `readSiteText` | fixture text, no fetch |
| `lib/onboarding/site-discovery.ts` `discoverSite` | a sitemap and a blog on the domain, `found: true` (or nothing for `unreadable.*`) |
| `lib/seo/client.ts` `hasDataForSEOCredentials` / `post` / `get` | `true`; every request throws |
| `lib/audit/domain-analysis.ts` `analyseDomain` | eight keywords inserted for the workspace; nothing else measured |
| `lib/content/generate.ts` `generateArticle` | a short fixture draft, written through the same rows (`articles`, `generation_jobs`) and the same `review` gate |

The switch is off by default, is not set in any deployment, and must stay
that small: add a stub only for a call that leaves the machine or costs money.

## Specs

| File | Covers |
| --- | --- |
| `onboarding.spec.ts` | `/dashboard` -> `/onboarding`, the reading state, five steps each persisting, the run screen, the plan on `/content`, the first draft in review on its day |
| `wizard-honesty.spec.ts` | an unreadable site shows the failure, the reason and Try again; the headline does not claim the fields were filled |
| `skip.spec.ts` | Skip setup writes `onboarding_skipped_at` and the dashboard stops redirecting |
| `approval-gate.spec.ts` | a draft in review has no publish control; approving moves it to `approved`; no `publish_log` row is written |
| `scope.spec.ts` | two workspaces on one agency; keywords and calendar show only the switched-to workspace |
| `signup.spec.ts` | an invalid domain is refused inline and creates neither an agency nor a user |

## CI

`.github/workflows/ci.yml` has an `e2e` job that runs on pull requests only:
it starts Supabase with the CLI (which applies the migrations), exports the
local keys, installs Chromium and runs the suite with `E2E_STUBS=1`. The
report is uploaded on failure. Pushes to `main` do not wait on it yet.
