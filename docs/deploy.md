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
| `apps/marketing` | Astro, fully static | Cloudflare Pages | by hand (`wrangler pages deploy`), or the optional workflow below |
| Database, auth, storage | Supabase (Postgres 17 + GoTrue + Storage) | a hosted Supabase project, or `supabase start` locally | migrations applied **by hand** |
| Scheduled jobs | nine `/api/cron/*` routes | Vercel Cron, plus GitHub Actions for the extra generate runs | `apps/web/vercel.json` on deploy; the workflow needs a repository secret |

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

- **The `reports` storage bucket.** `lib/reports/generate.ts` uploads PDF
  reports to a bucket called `reports` and reads them back with
  `getPublicUrl`. No migration creates it (045 creates `article-images`, the
  only bucket that is scripted). Create `reports` in *Storage* as a public
  bucket, or monthly reports fail with "Bucket not found".
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
authoritative example file with commentary is
[`docker/.env.example`](../docker/.env.example); this is the same list with
consequences attached.

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
| `CRON_SECRET` | `isAuthorizedCron()` returns `false` for every request; **all nine scheduled jobs answer 401** and nothing runs unattended. See [How cron auth works](#how-cron-auth-works) |
| `NEXT_PUBLIC_APP_URL` | links in every email, Stripe return URLs and the audit worker's self-call fall back to `http://localhost:3000` (or `:3100` in two files). Set it to the public origin |

### Each one disables exactly one feature

| Variable | Without it |
|---|---|
| `DATAFORSEO_LOGIN` + `DATAFORSEO_PASSWORD` (or a pre-encoded `DATAFORSEO_API_KEY`) | keyword volume, SERP analysis and rank tracking skip; research falls back to prompt-only |
| `OPENAI_API_KEY` | no featured images (articles publish without them); a workspace that selects the OpenAI provider fails |
| `PAGESPEED_API_KEY` | Core Web Vitals in audits report as unavailable (unkeyed requests hit Google's rate limit) |
| `RESEND_API_KEY` | no email at all: no invites, no auth emails (so **no signup confirmation or password reset**), no approval notifications, no feedback widget |
| `RESEND_FROM_EMAIL` | defaults to `AltoRank <noreply@updates.altorank.co>`, which will not be a verified sender on your Resend account. Set it |
| `FEEDBACK_EMAIL` | the in-app feedback widget mails a default address that is not yours |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Search Console connect returns `google_oauth_not_configured`. The redirect URI is `<origin>/api/auth/google/callback` and must be registered in Google Cloud |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_STARTER_YEARLY`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_GROWTH_YEARLY` | billing is hidden (`billingEnabled` is false). The webhook endpoint is `<origin>/api/webhooks/stripe` and has to be registered in Stripe by hand |
| `YOUTUBE_API_KEY` | no video embeds in articles; silently skipped |
| `ADMIN_EMAILS` | defaults to the AltoRank team's address, which is useless on your install. Comma-separated; set it to yourself. Set-but-empty means nobody is an operator |
| `ANTHROPIC_MODEL`, `ANTHROPIC_MODEL_STRUCTURED`, `OPENAI_MODEL`, `OPENAI_IMAGE_MODEL` | defaults from `lib/ai/models.ts` |
| `DOGFOOD_EMAIL` | only read by `scripts/dogfood.ts`; irrelevant to a deployment |

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

`apps/web/vercel.json` registers nine schedules. Vercel reads them from the
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
| `/api/cron/geo` | `0 8 * * 1` | AI-visibility measurement, weekly |
| `/api/cron/publish` | `0 9 * * *` | scheduled publishing |

**The Vercel account is on Hobby.** Hobby's documented rule is one run per day
per cron and hour-level precision (a `0 7 * * *` fires somewhere between 07:00
and 07:59). A schedule that would fire more than once a day does not get
silently throttled: **the deployment fails**, with *"Hobby accounts are limited
to daily cron jobs"*, and no build is created. That is why `vercel.json` has
nothing more frequent than daily, and why the self-host `docker/crontab` runs
`publish` every 15 minutes and `analyze` every 10 while the hosted product
gets them once a day: the container has no such rule.

`/api/cron/site-pages` exists and is authenticated like the others but is on
**no schedule anywhere** (not in `vercel.json`, not in `docker/crontab`). It
runs when someone calls it.

### The GitHub Actions cron fallback

`.github/workflows/generate-cron.yml` calls `/api/cron/generate` three more
times a day (01, 13, 19 UTC) so a site can reach its weekly pace. It hits the
same URL with the same secret as Vercel, so there is one code path and two
schedulers.

It is **dormant until `CRON_SECRET` is set as a repository secret** (*Settings
→ Secrets and variables → Actions*). Unset, the job prints that and exits 0
rather than failing four times a day. `APP_URL` can be overridden with a
repository *variable* to point at another deployment.

GitHub runs scheduled workflows best-effort and can be minutes late under
load. The generator is bounded by each workspace's weekly limit, not by
landing on the hour, so that is fine.

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

## `apps/marketing` on Cloudflare Pages

Fully static Astro (`output: 'static'`); nothing runs at request time.
`public/_headers` and `public/_redirects` are Cloudflare Pages files and are
copied into `dist/` as-is.

### Deploy by hand (what happens today)

From the repository root, on a clean checkout of `main`:

```bash
npm ci
npm run build:marketing         # astro build + scripts/generate-agent-files.mjs → apps/marketing/dist
npx wrangler login              # once; or export CLOUDFLARE_API_TOKEN
npx wrangler pages deploy apps/marketing/dist --project-name <pages-project> --branch main
```

or, equivalently, `CF_PAGES_PROJECT=<pages-project> npm run deploy -w apps/marketing`.

Two things about that command:

- **`--branch main`, not `master`.** Wrangler infers the branch from git when
  the flag is absent. The Pages project's production branch is `main`; a
  deploy tagged with any other branch (a worktree branch, `master` on an old
  clone) is published as a **preview** URL and the live site does not change.
  Pass the flag every time.
- **The `success-stories` warning is benign.** `astro build` prints that the
  `success-stories` collection is empty or does not exist. It is empty on
  purpose: the directory holds a `.gitkeep` and nothing else, because there
  are no case studies yet and the site does not pretend otherwise. The build
  succeeds; ignore the warning.

Environment variables for the marketing site (`PUBLIC_CF_ANALYTICS_TOKEN`
and one of the Umami / Plausible pairs, see
[`apps/marketing/.env.example`](../apps/marketing/.env.example)) are read at
build time. For a manual deploy they come from your shell; for a Git-connected
Pages project they are set under *Project → Settings → Environment variables*.

### Deploy automatically (optional)

Two ways, pick one:

1. **Cloudflare's Git integration.** Connect the Pages project to the GitHub
   repository with root directory `apps/marketing`, build command
   `npm run build`, output directory `dist`, production branch `main`, and
   Build System V2 (required for monorepo root directories). Set the build
   watch paths to `apps/marketing/*` so a dashboard-only commit does not
   trigger a marketing build. Note that Cloudflare's builder installs from
   the root lockfile; the marketing app pulls Astro 5's `rolldown` native
   binding, which is why CI now builds the marketing app too.
2. **`.github/workflows/deploy-marketing.yml`** (in this repository). On a
   push to `main` that touches `apps/marketing/**` it runs the same build and
   the same `wrangler pages deploy … --branch main`. It is dormant until two
   repository secrets exist:
   - `CLOUDFLARE_API_TOKEN`: an API token with *Cloudflare Pages: Edit* on the
     account, and nothing else.
   - `CLOUDFLARE_ACCOUNT_ID`: from the dashboard URL.

   Optionally the repository variable `CF_PAGES_PROJECT` (defaults to
   `altorank`). Without the secrets the job prints what is missing and exits
   0.

Do not enable both: two deployers racing on the same push is how a site ends
up one commit behind its own dashboard.

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
supabase start                       # Docker; prints API URL (…:54331), anon key, service_role key
supabase db push                     # applies the migrations to the local DB
cd ../..
cp docker/.env.example apps/web/.env.local
# fill NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54331 and the two keys from `supabase start`,
# ANTHROPIC_API_KEY, ENCRYPTION_KEY and CRON_SECRET (openssl rand -hex 32 for the last two)
npm run dev                          # http://localhost:3000
npm run dev:marketing                # http://localhost:4321
```

`supabase status` prints the values again; `supabase stop` keeps the data,
`supabase db reset` wipes it and re-applies every migration (useful for testing
a new one from scratch). Local Inbucket at `http://127.0.0.1:54334` shows any
email Supabase itself would send. The app's own emails go through Resend and
`lib/email/resend.ts` throws `RESEND_API_KEY not configured` without a key, so
locally the signup / reset / invite actions fail at the send step unless you set
one (a Resend test key works).

`npm run test` is vitest and needs no services. `npm run build` type-checks
and compiles with no env at all, which is exactly what CI does.

## Rollback

**`apps/web` (Vercel).** Deployments are immutable. In the project's
*Deployments* tab, pick the previous good one and *Promote to Production*
(or `vercel rollback` with the CLI). It takes effect in seconds and does not
rebuild. Then revert the commit on `main`, or the next push re-deploys the
bad one.

**`apps/marketing` (Pages).** Same idea: *Deployments → previous deployment →
Rollback to this deployment*, or `wrangler pages deployment list` and
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
2. **The `reports` storage bucket.** Not created by any migration.
3. **Environment variables on Vercel.** A new variable added to the code is a
   new variable to set in the dashboard; `NEXT_PUBLIC_*` additions also need
   a redeploy.
4. **Arming the GitHub Actions cron.** `CRON_SECRET` as a repository secret.
   Without it the hosted product generates once a day, not four times.
5. **The marketing deploy.** By hand, unless one of the two automatic paths
   above is switched on.
6. **Stripe webhook registration** (`/api/webhooks/stripe`) and the price ids.
7. **Google OAuth client** and its redirect URI.
8. **Supabase Auth URL configuration** (Site URL, redirect allow-list) and a
   verified Resend sender domain.
9. **The `site-pages` cron** has no schedule at all.
10. **Keeping `docker/crontab` and `vercel.json` in step.** They are meant to
    be identical lists. Today `vercel.json` has nine entries and the crontab
    eight (it predates `serp-collect`), and the two intervals that Hobby
    forbids differ on purpose. Change one, look at the other.

## Checklist for a fresh production deployment

```
[ ] Supabase project created; URL, anon key, service_role key, DB connection string noted
[ ] supabase link && supabase db push  (all migrations show as applied in `supabase migration list`)
[ ] `reports` bucket created (public)
[ ] Auth: Site URL + /callback in the redirect allow-list
[ ] Resend: sender domain verified; RESEND_API_KEY + RESEND_FROM_EMAIL
[ ] Vercel project: root apps/web, Node 22, region fra1, every env var set for Production
[ ] ENCRYPTION_KEY and CRON_SECRET generated with `openssl rand -hex 32` and stored somewhere you can recover them
[ ] ADMIN_EMAILS set to your own address
[ ] First push to main → deployment READY → /login renders
[ ] curl -H "x-cron-secret: …" https://<app>/api/cron/analyze returns 200, not 401
[ ] CRON_SECRET added as a GitHub repository secret (optional, for the extra generate runs)
[ ] Marketing: npm run build:marketing && wrangler pages deploy … --branch main
```
