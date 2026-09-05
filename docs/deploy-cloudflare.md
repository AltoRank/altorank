# Can all of AltoRank run on Cloudflare?

Short answer: the two applications can, the data layer cannot, and the
application that matters is not quite there yet.

- **`apps/marketing`** already runs on Cloudflare Pages. Nothing to do.
- **`apps/web`** builds for Cloudflare Workers with `@opennextjs/cloudflare`
  and serves pages, middleware, API routes and cron dispatch from `wrangler
  dev` today. This was tried on 2026-09-05; the evidence is below, including
  the one line the build printed in red. Two things stand between the
  experiment and a production deployment: the repository pins a Next.js
  version the current adapter refuses, and one `next.config.ts` redirect does
  not survive the port.
- **Postgres, auth and file storage** stay on Supabase. Cloudflare has no
  Postgres and no authentication service for end users. D1 is SQLite and
  cannot run a single one of the 47 migrations; Hyperdrive pools a Postgres you
  host somewhere else. Supabase runs either hosted or as its own Docker stack
  on a VM. Replacing it is sized honestly below, and the size is "a rewrite of
  the data layer", not "a weekend".

So "everything on Cloudflare" is compute, static hosting and scheduling on
Cloudflare with the database next door. That is a legitimate deployment and it
removes the one operational problem the Vercel Hobby plan has (the once-a-day
cron rule). It is not a way to stop paying for or running Postgres.

Everything below is checked against the code at the commit that added this
file, and against vendor documentation fetched on 2026-09-05. Where a claim
was not exercised, it says so.

## What was actually tried

Versions: Next.js 16.2.4 (what `apps/web/package.json` pins),
`@opennextjs/cloudflare` 1.20.6 (published 2026-09-02, latest), wrangler
4.129.0, Node 22. Placeholder environment only: an unreachable Supabase URL,
a made-up anon key, a made-up `CRON_SECRET`. No database, no real key of any
kind.

### Install

```
npm install --no-save -w apps/web @opennextjs/cloudflare wrangler
```

refuses:

```
npm error Could not resolve dependency:
npm error peer next@">=15.5.24 <16 || >=16.3.3" from @opennextjs/cloudflare@1.20.6
```

The adapter's peer range excludes 16.2.4. The floor has moved with each Next.js
security release (1.19.0 accepted `>=16.2.3`, 1.20.0 `>=16.2.6`, 1.20.2
`>=16.2.11`, 1.20.3 onward `>=16.3.3`); `npm audit` in this repository lists
22 published advisories against 16.2.4 with `next@16.3.4` as the fix, so the
floor is not arbitrary. The adapter's website says "all minor and patch
versions of Next.js 16" are supported; the package's `peerDependencies` is
what npm enforces, and it says otherwise. The experiment continued with
`--legacy-peer-deps`, which is fine for an experiment and not for production.
The real fix is to move `apps/web` to Next.js 16.3.x, which is a separate
change with its own build and test run.

### Build

With the two config files that are now in the repository
(`apps/web/open-next.config.ts`, `apps/web/wrangler.jsonc`):

```
cd apps/web && npx opennextjs-cloudflare build
```

Exit code 0. The complete list of everything it printed that was not routine:

```
WARN workerd compatibility_date: 2025-09-01, consider updating your wrangler config to a more recent date to benefit from the latest features and fixes.
⚠ The "middleware" file convention is deprecated. Please use "proxy" instead. Learn more: https://nextjs.org/docs/messages/middleware-to-proxy
ERROR Failed to copy /…/node_modules/color-string
```

The `ERROR` line did not stop the build. `color-string` is reached only from
`@react-pdf/renderer` (the monthly PDF reports); whether the report path works
at runtime is untested, see below. The `middleware` warning is Next.js 16
deprecating `middleware.ts` in favour of `proxy.ts` and has nothing to do with
Cloudflare; the adapter supports both (Node.js `proxy.ts` since 1.20.3, marked
experimental).

`next build` inside that run reported 46 routes, every one of them `ƒ`
(dynamic, rendered per request) and none `○` (static). That matters below:
there is nothing to cache, so none of the adapter's R2/KV/Durable Object cache
bindings are needed.

```
npx wrangler deploy --dry-run --outdir /tmp/x
Total Upload: 17216.12 KiB / gzip: 3626.62 KiB
```

17 MiB uncompressed. Cloudflare's limits page today states the Worker size
limit as 64 MiB uncompressed on both Free and Paid, with "no compressed size
limit". The adapter's documentation still quotes the older 3 MiB (Free) / 10
MiB (Paid) compressed figures; the bundle passes either way. One esbuild
warning about a duplicate object key `axisIndex` in the server bundle comes
from `fontkit` (again `@react-pdf`) and is benign.

On disk `.open-next/` is 50 MB: 46 MB of server function, 2.3 MB of static
assets (69 files). It is gitignored.

### Run

`npx wrangler dev --port 8797 --test-scheduled` with the placeholder values in
`.dev.vars`, then `curl`:

| Request | Vercel today | Workers (`wrangler dev`) | Meaning |
|---|---|---|---|
| `GET /signin` | 200 | **200**, `<title>Sign In \| AltoRank</title>`, 15 KB | Pages render. The middleware ran (`getUser()` against the unreachable Supabase returned no user; `/signin` is public). |
| `GET /dashboard` (no cookie) | 307 → `/signin` | **307 → `/signin`** | Deny-by-default middleware works. |
| `GET /?code=abc123` | 307 → `/callback?code=abc123` | **307 → `/callback?code=abc123`** | The stray-auth-code handler in middleware works. |
| `GET /clients` | 308 → `/workspaces` | **308 → `/workspaces`** | `next.config.ts` redirects are applied… |
| `GET /pricing`, `/blog/hello`, `/integrations` | 308 → `altorank.co/…` | **308 → `altorank.co/…`** | …including the external ones… |
| `GET /` (no `code`) | 308 → `https://altorank.co` | **404** | …except this one. See "Known gap" below. |
| `GET /api/cron/publish` | 401 | **401** `{"error":"Unauthorized"}` | Cron auth runs before any database call. |
| `GET /api/cron/publish` with the `.dev.vars` secret | (runs) | **500** `{"error":"Expected 3 parts in JWT; got 1"}` | The secret matched, so `process.env.CRON_SECRET` is visible at runtime; the route then died on the placeholder anon key, which is the correct failure with no database. |
| `GET /favicon.ico` | 200 | **200** | Static assets served from the `ASSETS` binding. |

Then the cron path. `wrangler.jsonc` points `main` at
`apps/web/cloudflare/worker.mjs`, which wraps the generated handler and adds a
`scheduled` handler; `--test-scheduled` exposes a local endpoint that fires it:

```
curl "http://localhost:8798/cdn-cgi/local/scheduled?cron=0+9+*+*+*"
ok
```

and in the Worker log:

```
cron /api/cron/publish -> 500 {"error":"Expected 3 parts in JWT; got 1"}
```

The trigger fired, the handler mapped `0 9 * * *` to `/api/cron/publish`,
called it through the `WORKER_SELF_REFERENCE` service binding with
`x-cron-secret`, got past the auth check and failed on the database, exactly
like the direct request above. An expression with no mapping logs
`cron: no route for schedule "1 1 * * *"` and does nothing.

What this does **not** prove: anything that needs Supabase to answer. Signing
in, every dashboard page past the redirect, generation, publishing, the PDF
report, CMS credential encryption. Those need a real Supabase URL and keys in
`.dev.vars`, which the experiment deliberately did not have.

## `apps/web` on Workers, point by point

### `node:crypto` AES-256-GCM (`lib/crypto.ts`)

`createCipheriv`/`createDecipheriv` with `aes-256-gcm`, `getAuthTag`,
`setAuthTag`, `randomBytes`, `createHash("sha256")`. Cloudflare's Node.js
compatibility page for `node:crypto` says all APIs are supported except
`generateKeyPair` with DSA/DH, `argon2`, the `ed448`/`x448` curves and FIPS
toggling. None of those is used. Requires the `nodejs_compat` flag, which
`wrangler.jsonc` sets. Not exercised in the run above (it needs a CMS
connection); confidence high from the documentation.

### Streaming responses (SSE)

Two routes build a `ReadableStream` and send `text/event-stream`:
`app/api/generate/route.ts` (the editor's live draft) and
`app/api/onboard/stream/route.ts` (the post-signup pipeline). Workers stream
responses natively and Cloudflare's limits page says there is "no hard limit
on duration for HTTP-triggered Workers. As long as the client remains
connected, the Worker can continue processing." The limit that applies is CPU
time, not wall time: 30 seconds by default on Paid, raisable to 300,000 ms
with `"limits": { "cpu_ms": 300000 }`, which `wrangler.jsonc` does. Generation
is almost entirely waiting on the model API, so CPU time is a small fraction
of the 103-second wall time per draft measured in
`lib/content/generate-queue.ts`. Not measured on workerd.

### `after()`

Three call sites (`app/actions/exchange.ts`, `app/actions/google-properties.ts`,
`app/api/audit/route.ts`). The adapter lists `after()` as supported; it maps
onto `ctx.waitUntil`. Untested here.

### Request duration versus the generation path

| Path | Declared | Vercel Hobby | Vercel Pro | Workers Paid |
|---|---|---|---|---|
| `/api/cron/generate`, `/api/cron/analyze`, `/api/cron/geo`, `/api/cron/site-pages`, `/api/onboard/stream` | `maxDuration = 300` | 300 s max | 300 s default, 800 s max | wall: unlimited while the caller is connected; CPU: up to 300 s |
| `/api/audit`, `/api/growth-plan`, `/api/cron/publish` | `maxDuration = 60` | fine | fine | fine |
| A cron invocation (`scheduled` handler) | – | – | – | 15 minutes wall, per Cloudflare's limits page |

`cron/generate` caps itself at `MAX_ARTICLES_PER_RUN = 2` (about 206 s) to fit
Vercel's 300. On Workers the `scheduled` handler has 15 minutes and calls the
route through the service binding, where the route runs under the HTTP
limits. The 300-second self-imposed budget still holds and could be raised;
this document does not recommend changing it until a real run has been
measured on workerd.

One limit with no Vercel equivalent: a Worker invocation may have at most six
outgoing connections waiting for response headers at once (further requests
queue, they do not fail). The site crawler and the audit fan out many
fetches; expect them to be slower, not broken. Not measured.

### `sharp` and image processing

There is no `sharp` in the dependency tree. Image work is: `lib/storage/images.ts`
downloads bytes with `fetch` and uploads them to Supabase Storage (works
anywhere `fetch` works); `@react-pdf/renderer` renders the monthly report to a
`Buffer` (`lib/reports/generate.ts`). `@react-pdf` bundled, with the two
warnings quoted above, and was not run. It depends on `yoga-layout` (WASM) and
`fontkit`; WASM runs on workerd, but the adapter's changelog shows it had to
patch how Next.js 16.3 loads WASM chunks, so treat the report path as
**unverified** until `/api/cron/reports` has been run once against a real
database.

`next/image` is used three times, all for local SVGs under `public/brand/`,
which Next serves as-is without the optimizer. If remote images ever go
through `next/image`, the `/_next/image` route on Workers needs Cloudflare's
Images binding or `images.unoptimized: true`.

### `lib/audit/lenient-fetch.ts`

The one place that uses `node:https`/`node:http` directly, to retry a fetch
with `rejectUnauthorized: false` when a site serves a broken certificate
chain. Under `nodejs_compat` with a compatibility date of 2025-08-15 or later
the Node HTTP client modules exist, but they are implemented on top of the
Workers `fetch`, which has no switch to skip certificate verification. So the
lenient retry will run and fail the same way the strict attempt did; a site
with a broken chain reads as unreachable in an audit instead of as "reachable,
chain unverified". Cosmetic loss, not a crash. Not tested (needs such a site).

### Bundle size

Above: 17.2 MiB / 3.6 MiB gzip against a 64 MiB uncompressed limit.
`googleapis` (Search Console, GA4, PageSpeed, indexing) is the largest single
dependency and is included in that figure.

### ISR, cache bindings

Not needed. Every route is dynamic; the middleware reads the session cookie on
every request. `open-next.config.ts` is `defineCloudflareConfig()` with no
arguments, which the adapter documents as "SSR route will work out of the box
without any caching config". If a static or ISR page is ever added, the
adapter needs an R2 bucket (incremental cache) and a Durable Object queue.

### Crons: the Hobby problem goes away

`apps/web/vercel.json` registers nine schedules. On Vercel Hobby a schedule
that fires more than once a day fails the whole deployment (see
[deploy.md](deploy.md#crons-and-the-hobby-limitation)). Cloudflare Cron
Triggers have no such rule; `"*/15 * * * *"`, which `docker/crontab` already
uses for `publish`, is legal.

The mapping, as committed in `wrangler.jsonc` and `cloudflare/worker.mjs`:

```jsonc
"triggers": {
  "crons": [
    "0 2 * * *",   // /api/cron/analyze
    "0 3 * * *",   // /api/cron/serp
    "20 3 * * *",  // /api/cron/serp-collect
    "0 4 * * *",   // /api/cron/analytics
    "0 5 * * *",   // /api/cron/exchange
    "0 6 1 * *",   // /api/cron/reports
    "0 7 * * *",   // /api/cron/generate
    "0 8 * * 1",   // /api/cron/geo
    "0 9 * * *"    // /api/cron/publish
  ]
}
```

Cloudflare delivers only the expression to the handler (`controller.cron`),
not a path, so `worker.mjs` holds the same nine expressions as keys and calls
the matching route with the `CRON_SECRET` Worker secret. Change a schedule in
one file, change it in the other; the handler logs loudly when they disagree.

Limits: 5 Cron Triggers per account on Workers Free, 250 on Paid. Nine
triggers therefore need the Paid plan, which the 10 ms CPU limit on Free
requires anyway. `.github/workflows/generate-cron.yml` keeps working
unchanged: it calls the same URL with the same secret.

### Environment variables

Verified: values in `.dev.vars` reach `process.env` at runtime (the
`CRON_SECRET` comparison passed). In production, every server-side variable
from the table in [deploy.md](deploy.md#environment-variables) becomes a
Worker secret:

```
cd apps/web
for v in SUPABASE_SERVICE_ROLE_KEY ANTHROPIC_API_KEY ENCRYPTION_KEY CRON_SECRET RESEND_API_KEY …; do
  npx wrangler secret put "$v"
done
```

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and
`NEXT_PUBLIC_APP_URL` are inlined by `next build`, so they must be in the
shell (or a `.env.production` file) when `opennextjs-cloudflare build` runs.
Both are public by design; putting them in `wrangler.jsonc` `vars` as well
does no harm.

### Middleware

`middleware.ts` is the Edge-runtime convention and runs on Workers as shown
above. When the app moves to `proxy.ts` (Node runtime, what Next.js 16 wants),
the adapter bundles it as a Node.js middleware; that support is marked
experimental in 1.20.3.

### Known gap: the root redirect

`next.config.ts` redirects `/` to `https://altorank.co` unless the request
carries `?code=` (an auth code has to reach the middleware instead). On Workers
`/` answers 404. The other seven redirects in the same file work, including
the external ones and the `/clients/:path*` pattern; the root one is the only
redirect with a `missing` condition, so that condition is the likely cause
(moderate confidence; not traced into the adapter). There is no `app/page.tsx`
to fall back to. Cheapest fix if this path is pursued: handle `/` in
`middleware.ts`, which already inspects `/?code=`.

### Region

`vercel.json` pins functions to `fra1` beside the EU Supabase project. Workers
run wherever the request arrives; every request then makes at least one round
trip to Supabase for `getUser()`. `"placement": { "mode": "smart" }` in
`wrangler.jsonc` lets Cloudflare move execution nearer the backend; it is not
set in the committed config because it should be measured, not assumed.

## Database, auth, storage: what the code needs

Counted in `apps/web` on 2026-09-05.

**Postgres via PostgREST.** Every query module uses `@supabase/supabase-js`
over HTTP. There is no `pg`, no Drizzle, no Prisma, no `.rpc()` call and no
realtime channel. 47 migrations in `apps/web/supabase/migrations/`, which
between them:

- `create policy` 40 times and `enable row level security` on 31 tables. The
  policies call `auth.uid()` and two SQL functions,
  `public.user_agency_ids()` and `public.user_admin_agency_ids()`, both
  `security definer` and both reading `auth.uid()`. RLS is the second line of
  defence behind the application's own scoping; take it away and every query
  module has to enforce the agency boundary itself.
- Reference `auth.users` (foreign keys) or `auth.uid()` in 7 files.
- Insert into `storage.buckets` and create a policy on `storage.objects`
  (migration 045, the `article-images` bucket).
- Use `gen_random_uuid()` 29 times and `jsonb` columns 35 times.
- Create no triggers, no PL/pgSQL, no extensions.

**Auth via GoTrue.** 13 distinct `supabase.auth.*` calls: `getUser` (22
sites), `getClaims`, `getSession`, `signInWithPassword`, `signOut`,
`setSession`, `exchangeCodeForSession`, `verifyOtp`, `updateUser`, and the
service-role admin API `admin.generateLink` (the app's own confirm / reset /
magic-link emails via Resend), `admin.getUserById`, `admin.listUsers`,
`admin.signOut`. Session cookies are managed by `@supabase/ssr` in
`middleware.ts`.

**Storage.** Two buckets: `article-images` (created by migration 045) and
`reports` (created by hand; see deploy.md). Upload, `getPublicUrl`.

### Option A: hosted Supabase (what production uses)

Nothing changes except where the Worker's secrets point. Free tier: 500 MB
database, 1 GB storage, 5 GB egress, and "free projects are paused after 1
week of inactivity" (a paused project makes every page a 500 until someone
unpauses it). Pro: $25 a month, including a $10 compute credit that covers one
Micro instance, 8 GB disk, 100 GB storage, 250 GB egress.

### Option B: self-hosted Supabase on a VM

Supabase's own `docker compose` stack: Postgres, Auth (GoTrue), PostgREST,
Storage, Realtime, Studio, Envoy, postgres-meta, imgproxy, Supavisor, Edge
Runtime, optionally Logflare and Vector. Supabase's stated minimum is 4 GB RAM,
2 cores, 40 GB SSD. The app needs Postgres, Auth, PostgREST and Storage;
the rest can be disabled. You operate backups, upgrades and TLS, and you
configure the auth URL allow-list and storage buckets from files instead of a
dashboard. Hetzner-class pricing for that VM is a few euros a month (order of
magnitude; not checked against a current price list).

Not Cloudflare, but it is the one way to run the whole product without a
managed database vendor.

### Option C: replace Supabase with Cloudflare primitives

What it would take, honestly:

| Supabase piece | Nearest Cloudflare thing | Gap |
|---|---|---|
| Postgres | **D1** (SQLite; 10 GB max on Paid, 500 MB on Free) | Not Postgres. No `auth.uid()`, no RLS, no `storage`/`auth` schemas, no `jsonb`, no `gen_random_uuid()`, no `security definer`. All 47 migrations rewritten by hand; the 40 policies become application code in every query module. |
| Postgres | **Hyperdrive** | "Turn your existing regional database into a globally distributed database." It pools and caches connections to a Postgres you still host. And the app speaks PostgREST over HTTP, not the Postgres wire protocol, so Hyperdrive would only matter after a rewrite to a SQL client. |
| GoTrue | nothing | Cloudflare Access is for a workforce, not for a product's customers. An auth library (Better Auth, Lucia, Auth.js) plus your own user, session and token tables, plus re-implementing the admin-generated link flow the auth emails rely on. |
| Storage | **R2** | The easy part: two modules, `upload` and a public URL. R2 has no row-level policies; public reads are per bucket. |
| PostgREST + supabase-js | nothing | Every one of the 13 query modules rewritten against whatever replaces the database. |

Estimate: weeks of work for one engineer who knows the schema, before any
data migration, and the result is a different product from the one this
repository ships (the migrations and RLS are the shared contract between
hosted, Docker and any future deployment). Not recommended.

## Recommendation

1. **Marketing on Pages** stays, and the workflow on this branch automates it
   once two secrets exist (below).
2. **`apps/web` on Workers is viable and is the way to escape the Hobby cron
   rule without paying Vercel Pro.** Prerequisites before anyone deploys it:
   Next.js 16.3.x in `apps/web/package.json` (also closes the open
   advisories); a fix for the `/` redirect; one full run against a real
   Supabase in `wrangler dev` covering sign-in, a generated draft, a publish
   and the PDF report. The config to do that is in the repository and is
   inert on Vercel.
3. **Supabase stays external**, hosted or self-hosted. Do not move the data
   layer to D1.

### Cost, per month, order of magnitude

| | Vercel Hobby (today) | Vercel Pro | Cloudflare Workers Paid |
|---|---|---|---|
| Base | $0, personal and non-commercial use only under Vercel's Hobby terms | $20 per seat, includes $20 of usage credit | $5 per account |
| Included | 100 GB transfer, 1M function invocations | 1 TB transfer, usage-billed functions (active CPU + provisioned memory) | 10M requests and 30M CPU-ms, then $0.30 per million requests and $0.02 per million CPU-ms; no egress charge |
| Function duration | 300 s hard | 300 s default, 800 s max | no wall limit; CPU up to 300 s per request, 15 min per cron |
| Crons | daily only, one run per day per cron, hour precision | any schedule | any schedule, 250 triggers |
| Static site | – | – | Pages Free: 500 builds a month, 1 concurrent build, 20,000 files, 25 MiB per file |
| Database | Supabase Free $0 (pauses after a week idle) or Pro $25 | same | same |

Realistic totals: Hobby + Supabase Free is $0 with a once-a-day product;
Workers Paid + Pages Free + Supabase Pro is about $30; Vercel Pro + Supabase
Pro is about $45 plus function usage. A self-hosted Supabase VM replaces the
$25 with the VM's price and your time.

## Migration checklist for `apps/web` to Workers

```
[ ] apps/web on Next.js >= 16.3.3 (npm install refuses the adapter below that)
[ ] npm install --no-save -w apps/web @opennextjs/cloudflare wrangler
[ ] npx wrangler login   (or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in the shell)
[ ] NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY / NEXT_PUBLIC_APP_URL in the shell for the build
[ ] npm run cf:build -w apps/web
[ ] apps/web/.dev.vars with real (staging) Supabase values; npx wrangler dev --test-scheduled
[ ] sign in, open the dashboard, generate a draft, publish, run
    curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=0+6+1+*+*"   (reports; the PDF path)
[ ] decide the `/` redirect (middleware or a page)
[ ] wrangler secret put for every server-side variable in deploy.md
[ ] npm run cf:deploy -w apps/web
[ ] custom domain on the Worker; NEXT_PUBLIC_APP_URL, Supabase Auth Site URL,
    Google redirect URI and the Stripe webhook all point at it
[ ] curl -H "x-cron-secret: …" https://<worker>/api/cron/analyze → 200
[ ] remove the Vercel project or leave it as a fallback, not both live on one domain
```

### What is in the repository for this

- `apps/web/open-next.config.ts`: `defineCloudflareConfig()`, nothing else.
- `apps/web/wrangler.jsonc`: `nodejs_compat`, compatibility date
  2025-09-01, the assets and self-reference bindings, `cpu_ms: 300000`, the
  nine Cron Triggers.
- `apps/web/cloudflare/worker.mjs`: `fetch` from the generated worker plus the
  `scheduled` dispatcher. Plain JavaScript, so `next build`'s type-check never
  sees it.
- `apps/web/package.json`: `cf:build`, `cf:preview`, `cf:deploy`. They assume
  the adapter and wrangler are installed; they are deliberately not
  dependencies, so `npm ci` on Vercel and in CI is unchanged.
- `apps/web/tsconfig.json` excludes `open-next.config.ts` and `cloudflare/`
  (otherwise `next build` fails to type-check when the adapter is not
  installed, i.e. on Vercel). `eslint.config.mjs` ignores `.open-next/` and
  `.wrangler/` (linting 46 MB of generated bundles runs Node out of heap).
- `apps/web/.gitignore`: `.open-next/`, `.wrangler/`, `.dev.vars`,
  `cloudflare-env.d.ts`.

`next build`, `vitest` (82 files, 827 tests) and `eslint` were run after these
were added; the first two pass, and eslint reports the same eight pre-existing
errors it reported before, none in the new files.

## `apps/marketing` on Pages: the workflow

`.github/workflows/deploy-marketing.yml` runs, on a push to `main` touching
`apps/marketing/**`:

```
npx --yes wrangler@4 pages deploy apps/marketing/dist \
  --project-name "${CF_PAGES_PROJECT}" \
  --branch main
```

Checked against wrangler 4's documented synopsis on 2026-09-05: `wrangler pages
deploy [<DIRECTORY>]` with `--project-name`, `--branch`, and optionally
`--commit-hash`, `--commit-message`, `--commit-dirty`, `--skip-caching`,
`--no-bundle`, `--upload-source-maps`. `pages publish` no longer exists in the
command set; the workflow does not use it. `--branch main` is passed
explicitly because wrangler otherwise infers the branch from git, and a deploy
tagged with anything but the project's production branch lands as a preview.

The Pages project must already exist (`npx wrangler pages project create
<name> --production-branch main`, once). Wrangler authenticates
non-interactively from two environment variables, which the workflow reads
from repository secrets (*Settings → Secrets and variables → Actions*):

| Secret | What | Scope |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | An API token created at *My Profile → API Tokens*. Permission: *Account → Cloudflare Pages → Edit*. Nothing else. | The one account that owns the Pages project |
| `CLOUDFLARE_ACCOUNT_ID` | The 32-hex account id from the dashboard URL (`dash.cloudflare.com/<account id>/…`) | – |

Optional repository *variable* `CF_PAGES_PROJECT` (default `altorank`). Until
both secrets exist the job prints what is missing and exits 0, so the
repository stays green while the marketing site is still deployed by hand.
Do not also connect the Pages project to GitHub: two deployers on one push
race.
