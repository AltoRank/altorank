# Public tools

`POST /api/public/tools/<slug>` — free, unauthenticated tools for altorank.co.
CORS allows `https://altorank.co` and `https://www.altorank.co` (`lib/growth-plan/http.ts`).

## Contract

Request: a JSON body, validated by the tool's zod schema.

```
200  { ok: true, data: { blocks: Block[] }, cached?: boolean }
err  { ok: false, error: "<sentence for a visitor>", code }
```

| code | status | when |
|---|---|---|
| `invalid_input` | 400 | body is not JSON, fails the schema, or names a private/local address |
| `not_found` | 404 | no tool with that slug |
| `rate_limited` | 429 | per-IP window for this tool is used up (`Retry-After` is set) |
| `daily_cap` | 429 | paid tools only: today's shared budget is spent, or the spend guard could not be reached |
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

The handler (`handler.ts`) does the rest in this order: validate → cache → per-IP limit →
spend reservation (paid kinds only; fails closed) → run with a 45s deadline.

## Spend guard

Paid kinds reserve `estimateCents` against one daily cap shared by all tools
(`spend.ts`, migration `091_public_tool_usage.sql`, RPC `reserve_public_tool_spend`).
Cap: `PUBLIC_TOOLS_DAILY_CAP_CENTS`, default 500. If the RPC errors (migration not applied,
DB unreachable) the paid tool answers `daily_cap`.

## Limits worth knowing

Rate limits and the answer cache are in memory, per instance, reset on deploy — they stop a
loop, not a distributed abuser. The daily cap is the hard backstop for paid tools.
