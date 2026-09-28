# Public tools

`POST /api/public/tools/<slug>` — free tools for altorank.co.
CORS allows `https://altorank.co` and `https://www.altorank.co` (`lib/growth-plan/http.ts`).

- `fetch` tools are anonymous.
- `ai` and `data` tools (the paid kinds) need a signed-in account with a confirmed email
  (an OAuth identity counts), and each account gets `PUBLIC_TOOLS_USER_DAILY_RUNS` successful
  runs per UTC day across all of them together (default 3). The widget calls with
  `credentials: "include"`; the answer carries `Access-Control-Allow-Credentials: true` and the
  exact origin, for the two production origins only (local Astro origins outside production).

## Contract

Request: a JSON body, validated by the tool's zod schema.

```
200  { ok: true, data: { blocks: Block[] }, cached?: boolean, remaining?: number }
err  { ok: false, error: "<sentence for a visitor>", code }
```

`remaining` is the account's runs left today, on a fresh paid run (not on a cache hit, which
does not count).

`GET /api/public/tools/me` (credentials) answers `{ signedIn: false }`,
`{ signedIn: true, verified: false }` or `{ signedIn: true, verified: true, remaining, limit }`,
so the widget can show the right state before anyone types. Nothing else about the account.

| code | status | when |
|---|---|---|
| `invalid_input` | 400 | body is not JSON, fails the schema, or names a private/local address |
| `auth_required` | 401 | paid tools only: nobody is signed in |
| `email_unverified` | 403 | paid tools only: signed in, email not confirmed |
| `not_found` | 404 | no tool with that slug |
| `rate_limited` | 429 | per-IP window for this tool is used up (`Retry-After` is set) |
| `user_cap` | 429 | paid tools only: this account has used today's runs (`Retry-After` = next UTC midnight) |
| `daily_cap` | 429 | paid tools only: today's shared budget is spent, or the spend guard or run count could not be reached |
| `upstream` | 502 | the site or a provider failed or timed out |
| `unknown` | 500 | our bug (logged; the caller sees a generic sentence) |

Blocks (`blocks.ts`): `text`, `list`, `table`, `kv` (items carry an optional
`status: pass | warn | fail | info`), `code`. Use the builders in `blocks.ts`.

## Adding a tool

1. Write `tools/<slug>.ts` exporting a `defineTool({...})` (`types.ts`):
   - `slug`, `kind` (`fetch` | `ai` | `data`), `input` (zod; use `publicUrl` from `url.ts` for any URL field),
   - `perIpLimit: { limit, windowMs }`,
   - `estimateCents` — 0 for `fetch`; for paid kinds, a deliberate upper estimate of one run,
   - optional `cacheTtlMs` (default 5 min, 0 disables),
   - `run(input, ctx) => Promise<Block[]>`.
2. Add it to `TOOLS` in `registry.ts`.
3. Add `__tests__/<slug>.test.ts`. Pass a fake `ctx.fetch`; never hit the network or Supabase.

Inside `run`:

- **Fetch URLs only through `ctx.fetch`** (the SSRF-guarded `safeFetch`). Never `fetch()`,
  `fetchSite()` or an SDK pointed at a user-supplied URL. Pass `signal: ctx.signal`.
- **AI**: `askHaiku` / `askHaikuJson` from `ai.ts` (pinned model, capped output, spend recorded,
  errors mapped to `upstream`). Pass `signal: ctx.signal`.
- **DataForSEO**: `dataforseoLive` from `data.ts` (live endpoints only).
- Throw `ToolError(code, sentence)` for anything the visitor should read. Anything else becomes `unknown`.

The handler (`handler.ts`) does the rest in this order: validate → account (paid kinds) → cache →
per-IP limit → the account's run (paid kinds; fails closed) → spend reservation (paid kinds; fails
closed) → run with a 45s deadline. A paid run that fails `upstream` or `unknown` gives the
account's run back.

## Paid tools: shared pieces

- `fields.ts`: zod fields matching the altorank.co forms (`requiredText`, `optionalText` where "" means
  absent, `pastedText` with a word cap, `choice`, `countryInput`, `publicDomain`). Field names and limits
  must match the marketing repo's `src/data/server-tools.ts`; `__tests__/paid-registry.test.ts` holds a
  body per form.
- `locations.ts`: form country code (`us`, `gb`, …) to DataForSEO location + language.
- `prompt.ts`: visitor input goes in a named tag (`tagged`) under `INPUT_RULES`; helpers for checks done
  in code rather than trusted to the prompt (`charLength`, `unsupportedTerms`, `lostFigures`).
- `labs.ts`: the DataForSEO Labs keyword fields the data tools read. Missing numbers stay null.
- Tools that take pasted text set `cacheTtlMs: 0`.

## Spend guard

Paid kinds reserve `estimateCents` against one daily cap shared by all tools
(`spend.ts`, migration `091_public_tool_usage.sql`, RPC `reserve_public_tool_spend`).
Cap: `PUBLIC_TOOLS_DAILY_CAP_CENTS`, default 500. If the RPC errors (migration not applied,
DB unreachable) the paid tool answers `daily_cap`.

## Account runs

Each paid run first takes one of the account's runs for the UTC day (`user-runs.ts`, migration
`103_public_tool_user_runs.sql`, RPCs `reserve_public_tool_user_run` / `release_public_tool_user_run`).
Limit: `PUBLIC_TOOLS_USER_DAILY_RUNS`, default 3. If the RPC errors the paid tool answers
`daily_cap` (fail closed). The shared budget above stays as the backstop.

## Signing up from a tool

A tool page links to `/signup?from=tools&return_to=https://altorank.co/tools/<slug>/` (or
`/signin?return_to=...`). `return-url.ts` accepts exactly that shape and reduces it to the slug;
the slug travels as `next=/tool-return/<slug>` through the confirmation email and `/callback`,
and `/tool-return/<slug>` redirects to the tool page with `?run=1`, where the widget restores the
saved input and runs it once. The tools signup asks for email and password only and creates no
account row or workspace; the app creates the account when the person first opens it, and sends
a person with no site to add one (onboarding then applies as usual).

## Limits worth knowing

Rate limits and the answer cache are in memory, per instance, reset on deploy — they stop a
loop, not a distributed abuser. The daily cap is the hard backstop for paid tools.
