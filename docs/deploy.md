# Deploying AltoRank

How the two apps get to production today, what a self-hoster has to do by
hand, and where the sharp edges are. Everything here is checked against the
code in this repository; where the repository and a hosting dashboard
disagree, the repository wins and the dashboard is wrong.

The Cloudflare question ("can all of it run there?") has its own page:
[deploy-cloudflare.md](deploy-cloudflare.md).

## The shape of it

| Piece | What it is | Where it runs | How it gets there |
|---|---|---|---|
| `apps/web` | Next.js 16 dashboard and engine | Vercel (`fra1`) | automatically, on every push to `main` |
| Database, auth, storage | Supabase (Postgres 17 + GoTrue + Storage) | a hosted Supabase project, or `supabase start` locally | migrations applied **by hand** |
| Scheduled jobs | twelve `/api/cron/*` routes | Vercel Cron, plus GitHub Actions for the extra generate and publish runs | `apps/web/vercel.json` on deploy; the workflows need a repository secret |

There is also a `docker/` setup that runs `apps/web` and a cron sidecar as two
containers against a Supabase you provide. It is the self-host path if you do
not want Vercel.

## Prerequisites

- **Node 22.** `package.json` says `engines.node >= 22`, CI builds on 22, the
  Docker image is `node:22-alpine`. Node 20 is not tested.
- **npm** (the lockfile is npm's; `npm ci` is what CI runs). Both apps are npm
  workspaces of the root, so install once at the root.
- **A Supabase project**, hosted or local. Nothing in `apps/web` runs without
  one: every query module talks to Supabase directly and there is no other
  storage backend.
- **The Supabase CLI** (`npm i -g supabase`, or `npx supabase`) for local
  development and for `supabase db push`. `psql` works instead for hosted
  projects if you prefer.
- **An Anthropic API key.** Generation, fact-checking, scoring, briefs and
  summaries are all Claude calls. Without it the dashboard loads and every
  AI-backed action fails.

## Supabase: project setup

### 1. Create the project

Hosted: create a project in the Supabase dashboard, region of your choice
(production is EU). Note the project ref, the API URL, the `anon` key and the
`service_role` key from *Project Settings → API*, and the direct database
connection string from *Project Settings → Database*.

Local: see [Local development](#local-development) below; `supabase start`
prints the same four values.

### 2. Apply the migrations, in order

`apps/web/supabase/migrations/` holds numbered SQL files, `001_…` upward.
**They are not applied by CI or by the deploy.** Someone runs them. Every one
of them must run, in filename order, exactly once; a deploy that goes out ahead
of its migration fails at runtime with "relation does not exist" or "column
does not exist" on whichever page first touches the new schema.

With the Supabase CLI, from `apps/web`:

```bash
cd apps/web
supabase link --project-ref <your-project-ref>   # once; asks for the database password
supabase migration list                          # shows Local vs Remote; anything missing on Remote is pending
supabase db push                                 # applies the pending ones, in order, and records them
```

`supabase db push` records what it applied in `supabase_migrations.schema_migrations`,
so running it twice is safe and running it after a new migration lands applies
only the new one. Prefer it.

With `psql` against the direct connection string (no bookkeeping, so you own
the "which ones have I run" question):

```bash
cd apps/web/supabase/migrations
for f in $(ls *.sql | sort); do
  echo "== $f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f" || break
done
```

`ON_ERROR_STOP=1` matters: without it psql prints the error and carries on,
and you end up half-migrated. If you use this path, apply *only* the files you
have not applied before; the migrations are not all idempotent.

Take a backup first on anything that matters (`supabase db dump -f
pre-<nnn>.sql` or `pg_dump`). There are no down migrations.

### 3. Things the migrations do not do

- **Do not create the `reports` bucket by hand.** Migration 066 creates it,
  private and PDF only, and the app hands out signed links to each report
  (`lib/reports/generate.ts`). A public `reports` bucket serves every client's
  traffic and keyword figures to anyone holding a link. If you made one by
  hand on an earlier version, applying 066 switches it back to private; check
  *Storage → reports* says private afterwards.
- **Auth URL configuration.** Set *Authentication → URL Configuration → Site
  URL* to your app's origin and add `<origin>/callback` to the redirect
  allow-list. The app sends its own auth emails (below), but OAuth codes
  still round-trip through `/callback`.
- **Auth email delivery.** The app does *not* use Supabase's mailer for
  confirm / reset / magic-link: `lib/email/auth-emails.ts` generates the link
  with the service role and sends it through Resend. So `RESEND_API_KEY` is
  what makes signup and password reset work in production, not Supabase's
  SMTP settings.

## Environment variables

Everything `apps/web` reads, grouped by what stops working without it. The
example file with commentary is [`docker/.env.example`](../docker/.env.example);
this is the same list with consequences attached. `docker/compose.yml` forwards
every variable in it to the container.

`NEXT_PUBLIC_*` values are inlined into the client bundle at **build time**.
On Vercel that means they must be set before the build runs; in Docker they are
build args, not runtime env.

### Will not boot without

| Variable | Without it |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | every Supabase client is constructed with `undefined`; the first request throws |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | same |

### Boots, but the product does not work

| Variable | Without it |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | every cron route, billing spend recording, invites, operator "view as", auth emails and the onboarding pipeline build a service client with an undefined key and fail. Server-only; never give it a `NEXT_PUBLIC_` prefix |
| `ANTHROPIC_API_KEY` | no generation, no fact-check, no briefs, no summaries |
| `ENCRYPTION_KEY` | `lib/crypto.ts` throws; **no CMS can be connected** and existing connections cannot be decrypted. 64 hex chars (`openssl rand -hex 32`); any other string is SHA-256'd to a key. Rotating it makes stored credentials unreadable, by design |
| `CRON_SECRET` | `isAuthorizedCron()` returns `false` for every request; **every scheduled job answers 401** and nothing runs unattended. `docker compose` refuses to start the cron container without it. See [How cron auth works](#how-cron-auth-works) |
| `RESEND_API_KEY` | no email at all: no invites, no auth emails, no approval notifications, no feedback widget. Signup confirms by email and rolls the new user back when the email cannot be sent, so **nobody can create an account** and nobody can reset a password |
| `RESEND_FROM_EMAIL` | defaults to `AltoRank <noreply@updates.altorank.co>`, which will not be a verified sender on your Resend account, so every send is refused (same effect as no key). Set it |
| `NEXT_PUBLIC_APP_URL` | links in every email, Stripe return URLs and the audit worker's self-call fall back to `http://localhost:3000` (or `:3100` in two files). Set it to the public origin |

### Each one disables exactly one feature

| Variable | Without it |
|---|---|
| `DATAFORSEO_LOGIN` + `DATAFORSEO_PASSWORD` (or a pre-encoded `DATAFORSEO_API_KEY`) | keyword volume, SERP analysis and rank tracking skip; research falls back to prompt-only |
| `OPENAI_API_KEY` | no featured images (articles publish without them); a workspace that selects the OpenAI provider fails |
| `PAGESPEED_API_KEY` | Core Web Vitals in audits report as unavailable (unkeyed requests hit Google's rate limit) |
| `FEEDBACK_EMAIL` | the in-app feedback widget and "Request integration" send nothing and say feedback is not configured |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Search Console connect returns `google_oauth_not_configured`. The redirect URI is `<origin>/api/auth/google/callback` and must be registered in Google Cloud |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_STARTER_YEARLY`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_GROWTH_YEARLY` | billing is off (`billingEnabled` is false) and every account is unmetered. `STRIPE_SECRET_KEY` alone turns billing on, so set all six or none. The webhook endpoint is `<origin>/api/webhooks/stripe` and has to be registered in Stripe by hand |
| `STRIPE_TAX_ENABLED` | Checkout charges the listed price and adds no VAT: no `automatic_tax`, no `tax_id_collection`, so no reverse charge for EU businesses. Set it to `true` **only** once Stripe Tax is activated, registered and set to exclusive - see [VAT](#2-vat-off-by-default-behind-stripe_tax_enabled). Turning it on before that stops anyone paying |
| `YOUTUBE_API_KEY` | no video embeds in articles; silently skipped |
| `ADMIN_EMAILS` | nobody is an operator: `/admin/*` and "View as" are closed to everyone, and the daily operations digest sends nothing. Comma-separated; set it to yourself if you want them |
| `ANTHROPIC_MODEL`, `ANTHROPIC_MODEL_STRUCTURED`, `ANTHROPIC_MODEL_DECISION`, `OPENAI_MODEL`, `OPENAI_IMAGE_MODEL` | defaults from `lib/ai/models.ts`. `ANTHROPIC_MODEL` pins every Claude tier at once; the other two override one tier each |
| `PUBLIC_TOOLS_DAILY_CAP_CENTS`, `PUBLIC_TOOLS_MODEL` | the paid public tools (`/api/public/tools/<slug>`, no sign-in) spend at most this many US cents a day of your Anthropic and DataForSEO keys. Unset means **0 with billing off** (the paid tools are off on a self-host until you set a budget) and 500 with billing on |
| `EMAIL_UNSUBSCRIBE_SECRET` | the service role key signs unsubscribe and Hold links instead |
| `ALTORANK_ALLOW_PRIVATE_FETCH` | audits refuse private and local addresses. Set `1` to audit sites on your own network |
| `TRIAL_GATE_DISABLED`, `TRIAL_GATE_BYPASS_EMAILS`, `PRETRIAL_FULL_ARTICLE` | billing only: the card-trial step before the dashboard, addresses that skip it, and whether an owner can read their first draft in full before the trial |
| `DOGFOOD_EMAIL` | only read by `scripts/dogfood.ts`; irrelevant to a deployment |
| the two `NEXT_PUBLIC_POSTHOG_*` variables (project token, host) | no product analytics; `npm run dev` logs one console warning. Read at build time; `docker/compose.yml` does not pass them, so the Docker image never sends analytics |

## `apps/web` on Vercel

### Deploy

The Vercel project is connected to this repository. **Every push to `main`
builds and deploys production.** There is nothing to run; a green CI run on the
PR is the only gate.

Project settings that have to match the repository:

- Root directory: `apps/web`. Framework preset: Next.js. Node 22.
- Build command: default (`next build`). `output: "standalone"` in
  `next.config.ts` is for the Docker image; Vercel ignores it.
- Region: `fra1`, pinned in `apps/web/vercel.json` so the functions sit next
  to the EU Supabase project.
- Every variable in the table above, in *Settings → Environment Variables*,
  for Production (and Preview if you want previews that work). Remember the
  `NEXT_PUBLIC_*` ones are baked in at build time: changing one needs a
  redeploy, not just a restart.

### Function duration

Several routes declare `export const maxDuration = 300` (the cron routes,
`/api/onboard/stream`) or `60` (`/api/audit`, `/api/growth-plan`,
`/api/cron/publish`). One article draft was measured at 103 seconds end to
end (`lib/content/generate-queue.ts`), and the generate cron caps itself at
two drafts per run so that it fits inside 300. A plan whose function ceiling is
below 300 seconds will cut generation off mid-draft.

### Crons, and the Hobby limitation

`apps/web/vercel.json` registers twelve schedules. Vercel reads them from the
deployed file, so a change to the file is live on the next deploy and
nowhere else.

| Path | Schedule (UTC) | What |
|---|---|---|
| `/api/cron/analyze` | `0 2 * * *` | domain analysis, topical profile |
| `/api/cron/serp` | `0 3 * * *` | posts rank-check tasks to DataForSEO |
| `/api/cron/serp-collect` | `20 3 * * *` | collects the results twenty minutes later |
| `/api/cron/analytics` | `0 4 * * *` | Search Console / Bing sync |
| `/api/cron/exchange` | `0 5 * * *` | backlink exchange |
| `/api/cron/reports` | `0 6 1 * *` | monthly PDF reports |
| `/api/cron/generate` | `0 7 * * *` | autonomous drafts (bounded, see above) |
| `/api/cron/refresh` | `30 7 * * *` | content refresh for workspaces that turned it on in Settings |
| `/api/cron/geo` | `0 8 * * 1` | AI-visibility measurement, weekly; measures only workspaces with `geo_tracking` on and prompts in `geo_prompts`, which nothing in the app sets yet |
| `/api/cron/publish` | `0 9 * * *` | scheduled publishing |
| `/api/cron/site-pages` | `0 10 * * *` | re-reads one site's sitemap pages per run, stalest first, and checks whether a draft already went live on the site |
| `/api/cron/ops-digest` | `0 11 * * *` | daily operations digest to `ADMIN_EMAILS` |

**The Vercel account is on Hobby.** Hobby's documented rule is one run per day
per cron and hour-level precision (a `0 7 * * *` fires somewhere between 07:00
and 07:59). A schedule that would fire more than once a day does not get
silently throttled: **the deployment fails**, with *"Hobby accounts are limited
to daily cron jobs"*, and no build is created. That is why `vercel.json` has
nothing more frequent than daily, and why the self-host `docker/crontab` (and
the Cloudflare triggers) run `publish` every 15 minutes, `analyze` every 10 and
`generate` four times a day while the hosted product gets them once a day from
Vercel: the container has no such rule.

`docker/crontab`, `apps/web/wrangler.jsonc` and `apps/web/cloudflare/worker.mjs`
schedule the same twelve jobs; `apps/web/lib/__tests__/cron-schedules.test.ts`
fails when any of them misses a route under `app/api/cron/`, and when a job
other than those three runs on a different schedule from `vercel.json`.

Cloudflare Cron Triggers have no once-a-day rule; if the Hobby limitation is
the reason to move, [deploy-cloudflare.md](deploy-cloudflare.md#crons-the-hobby-problem-goes-away)
maps the schedules onto them.

### The GitHub Actions cron fallback

Two workflows add the runs Hobby will not schedule. They hit the same URLs
with the same secret as Vercel, so there is one code path and two schedulers.

- `.github/workflows/generate-cron.yml` calls `/api/cron/generate` three more
  times a day (01, 13, 19 UTC). Each run writes at most two drafts, so the
  extra runs are what let a site reach its weekly pace.
- `.github/workflows/publish-cron.yml` calls `/api/cron/publish` every hour
  except 09 UTC (Vercel's run). Without it a site whose local publish time is
  later than 09:00 UTC is never reached: the cadence gate is "at or after the
  publish time", and there is no later run to satisfy it.

Both are **dormant until `CRON_SECRET` is set as a repository secret**
(*Settings → Secrets and variables → Actions*). Unset, the job prints that and
exits 0 rather than failing every run. Set the `APP_URL` repository
*variable* to your deployment's origin. Only `AltoRank/altorank` itself falls
back to the hosted URL; in any other repository the workflows refuse to run
without `APP_URL`, so a fork never sends its secret to someone else's server.

GitHub runs scheduled workflows best-effort and can be minutes late under
load. The generator is bounded by each workspace's weekly limit, not by
landing on the hour, and the publisher publishes at most once per local day,
so that is fine.

### How cron auth works

`apps/web/lib/cron-auth.ts`, covered by `lib/__tests__/cron-auth.test.ts`:

- The secret is read from `x-cron-secret` first, then from
  `Authorization: Bearer <secret>`. Vercel's scheduler sends the latter;
  every manual and self-host caller sends the former. Until 2026-09-02 the
  routes checked only `x-cron-secret`, so in production every scheduled run
  got a 401 that nobody saw, because a 401 is not an error to the scheduler.
- If `CRON_SECRET` is unset, `isAuthorizedCron()` returns `false` for every
  request, including `Bearer ` with an empty token. There is no
  "no secret configured, allow all" mode.
- Comparison is exact string equality.

To run a job by hand:

```bash
curl -fsS -H "x-cron-secret: $CRON_SECRET" https://<your-app>/api/cron/generate
```

## Stripe

Billing is off until `STRIPE_SECRET_KEY` is set (`billingEnabled` in
`apps/web/lib/stripe.ts`); a self-hosted install without it runs unmetered.
When it is on, three things live in the Stripe dashboard and nothing in this
repository can set them:

### 1. The webhook endpoint and its events

Endpoint URL: `https://<your-app>/api/webhooks/stripe`. Its signing secret is
`STRIPE_WEBHOOK_SECRET`. Subscribe it to exactly these events - the list is
`REQUIRED_STRIPE_EVENTS` in `apps/web/lib/stripe.ts`, and a test fails if the
route stops handling any of them:

| Event | Without it |
|---|---|
| `checkout.session.completed` | `plan_status` never becomes active after checkout |
| `customer.subscription.created` | a subscription started outside our checkout is never mapped to an account |
| `customer.subscription.updated` | plan changes, cancel-at-period-end and the period end are never recorded |
| `customer.subscription.deleted` | cancellations never land; access never ends |
| `invoice.payment_failed` | the past-due grace window and dunning banner never start |
| `invoice.paid` | a recovered payment never clears them |

A missing event fails silently: Stripe simply never calls, and the product
shows whatever state it last knew.

### 2. VAT: off by default, behind `STRIPE_TAX_ENABLED`

By default Checkout charges the listed price and adds no VAT: the session sends
no tax fields at all. That is deliberate and load-bearing. `automatic_tax` is
rejected by Stripe unless Stripe Tax is activated on the account, so turning it
on before the account is ready does not collect tax - it stops anyone paying.

To start collecting VAT, in this order:

1. **Tax → Settings → Business information**: activate Stripe Tax with the
   head-office address and register (Tax → Registrations) wherever you owe VAT.
   The products carry no tax code of their own, so the *Preset product category*
   is what `automatic_tax` uses; without one it errors at checkout. Stripe's
   default, *Electronically Supplied Services* (`txcd_10000000`), is the right
   answer for an EU seller: SaaS is an electronically supplied service and it
   lands on the standard rate. *Software as a service (SaaS) – business use*
   (`txcd_10103001`) is the narrower code and only pays for itself in the US,
   where some states treat business SaaS differently from digital services
   generally — and it is the wrong code if consumers can buy, which on this
   product they can.
2. **Tax → Settings → Include tax in prices → No.** The default is *Automatic*,
   which excludes tax for USD and CAD and **includes it for every other
   currency**. Prices here are in euros, so *Automatic* means Stripe reads €69 as
   tax-inclusive and carves the VAT out of it: €56.56 to you instead of €69, with
   nothing in the UI to say so. *No* adds VAT on top, which is what the pricing
   page promises.

   The account setting is changeable and applies to any Price whose own
   `tax_behavior` is `unspecified`. Setting `tax_behavior` **on a Price** is
   different: that is permanent, and a price created as inclusive has to be
   replaced rather than edited.
3. Set `STRIPE_TAX_ENABLED=true` on the deployment and redeploy. The session
   then sends `automatic_tax`, `tax_id_collection` (the VAT number that triggers
   the reverse charge for EU businesses) and keeps the customer's address for
   renewals.
4. Update the pricing page and Terms §5, which say prices are charged as listed.

`stripeTaxEnabled` in `apps/web/lib/stripe.ts` is the switch and repeats these
preconditions.

## The marketing site

`altorank.co` is no longer in this repository. It lives in
`AltoRank/altorank-marketing` (private) and deploys itself to the Cloudflare
Pages project `altorank-marketing`; that repo's README carries the build and
deploy steps.

Only one thing here still concerns it: `apps/web/lib/stripe.ts` and
`apps/web/lib/billing/quota.ts` enforce plan limits that the site's pricing page
restates. Nothing checks the two repositories agree, so change them together.

## Local development

`apps/web/supabase/config.toml` moves every Supabase service off the CLI's
default ports, so it can run alongside another Supabase project on the same
machine:

| Service | Port | Default would be |
|---|---|---|
| API (the `NEXT_PUBLIC_SUPABASE_URL`) | **54331** | 54321 |
| Postgres | **54332** | 54322 |
| Shadow DB (used by `db diff`) | 54330 | 54320 |
| Studio | **54333** | 54323 |
| Inbucket (captured emails) | **54334** | 54324 |
| Analytics | 54337 | 54327 |

`major_version = 17` in that file must match the hosted project's Postgres
major (`SHOW server_version;`), or `db diff` and `db reset` compare against
the wrong engine.

```bash
npm ci
cd apps/web
supabase start                       # Docker; applies every migration, prints API URL (…:54331), anon key, service_role key
cd ../..
cp docker/.env.example apps/web/.env.local
# fill NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54331 and the two keys from `supabase start`,
# ANTHROPIC_API_KEY, ENCRYPTION_KEY and CRON_SECRET (openssl rand -hex 32 for the last two)
npm run dev                          # http://localhost:3000
```

`supabase status` prints the values again; `supabase stop` keeps the data,
`supabase db reset` wipes it and re-applies every migration (useful for testing
a new one from scratch). Local Inbucket at `http://127.0.0.1:54334` shows any
email Supabase itself would send. The app's own emails go through Resend and
`lib/email/resend.ts` throws `RESEND_API_KEY not configured` without a key, so
locally the signup / reset / invite actions fail at the send step unless you set
one (a Resend test key works).

`npm run test` is vitest and needs no services; a network guard fails any test
that opens a connection. `npm run test:db` runs the `*.db.test.ts` files against
the stack from `supabase start`. It takes the Supabase URL and keys (and
nothing else) from the files `next dev` reads, refuses to run at all if any
database URL is not on this machine, and refuses every connection that leaves
it (lib/__tests__/support/). `npm run build` type-checks and compiles with no
env at all, which is exactly what CI does.

## Rollback

**`apps/web` (Vercel).** Deployments are immutable. In the project's
*Deployments* tab, pick the previous good one and *Promote to Production*
(or `vercel rollback` with the CLI). It takes effect in seconds and does not
rebuild. Then revert the commit on `main`, or the next push re-deploys the
bad one.

re-deploy the old `dist/` from the matching commit with the command above.

**Database.** There are no down migrations. Rolling back a schema change means
restoring the backup you took before applying it, or writing a new forward
migration that undoes it. Application rollbacks that cross a migration are the
dangerous case: the old code may not know about a `NOT NULL` column the new
migration added. Sequence a risky change as *migration first (additive), then
code, then a later migration that tightens*.

## What is NOT automated

The honest list. Each item is a thing a person does, and each has bitten at
least once.

1. **Database migrations.** Not run by CI, not run by the deploy. A merged
   PR with a migration is not live until someone runs `supabase db push`
   against production.
2. **Environment variables on Vercel.** A new variable added to the code is a
   new variable to set in the dashboard; `NEXT_PUBLIC_*` additions also need
   a redeploy.
3. **Arming the GitHub Actions crons.** `CRON_SECRET` as a repository secret,
   and `APP_URL` as a repository variable outside `AltoRank/altorank`.
   Without them a Vercel deployment generates and publishes once a day.
4. **The marketing deploy.** By hand, unless one of the two automatic paths
   above is switched on.
5. **Stripe webhook registration** (`/api/webhooks/stripe`) and the price ids. See **Stripe** below for the six events and the price setting nothing here can set.
6. **Google OAuth client** and its redirect URI.
7. **Supabase Auth URL configuration** (Site URL, redirect allow-list) and a
   verified Resend sender domain.
8. **Keeping `docker/crontab`, `vercel.json`, `apps/web/wrangler.jsonc` and
   `apps/web/cloudflare/worker.mjs` in step.** They schedule the same twelve
   jobs, and `cron-schedules.test.ts` fails when one misses a route. The three
   schedules Hobby forbids (`publish`, `analyze`, `generate`) differ on
   purpose between the crontab and `vercel.json`.

## Checklist for a fresh production deployment

```
[ ] Supabase project created; URL, anon key, service_role key, DB connection string noted
[ ] supabase link && supabase db push  (all migrations show as applied in `supabase migration list`)
[ ] Storage → `reports` exists and is private (migration 066 creates it)
[ ] Auth: Site URL + /callback in the redirect allow-list
[ ] Resend: sender domain verified; RESEND_API_KEY + RESEND_FROM_EMAIL
[ ] Vercel project: root apps/web, Node 22, region fra1, every env var set for Production
[ ] ENCRYPTION_KEY and CRON_SECRET generated with `openssl rand -hex 32` and stored somewhere you can recover them
[ ] ADMIN_EMAILS set to your own address
[ ] First push to main → deployment READY → /login renders
[ ] curl -H "x-cron-secret: …" https://<app>/api/cron/analyze returns 200, not 401
[ ] CRON_SECRET as a GitHub repository secret and APP_URL as a repository variable (optional, for the extra generate and publish runs)
```
