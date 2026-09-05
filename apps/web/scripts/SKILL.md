---
name: altorank
description: Drive AltoRank from a coding agent - audit a site's agent readiness, find keywords, and write SEO drafts into a human's review queue. Never publishes.
---

# AltoRank for coding agents

AltoRank writes search and AI-search content for websites. You can read an
account and create **drafts**. A person reviews, approves and publishes in the
editor. There is no publish, approve or delete call in this API, and you must
not look for a way around that.

Two surfaces, one contract:

- **HTTP** `GET/POST {ALTORANK_BASE_URL}/api/agent/v1/...` with
  `Authorization: Bearer $ALTORANK_API_KEY`.
- **CLI** `npm run cli -- <group> <command>` from `apps/web` (or `tsx scripts/cli.ts`).
  Same calls, prints the same envelope, exits 1 on failure.

The MCP server (`scripts/mcp.ts`) exposes the public readiness tools with no
key, and the account tools below when `ALTORANK_API_KEY` is set.

## The envelope

Every response, every surface:

```json
{ "ok": true,  "data": { ... }, "agent_guidance": "What to do next." }
{ "ok": false, "error": { "code": "unauthorized", "message": "..." }, "agent_guidance": "How to fix it." }
```

- Read `agent_guidance` first. It is written for you, and it is the fastest
  route out of an error.
- `_human` (when present) is how to describe the record to a person: use the
  labels and `value_label`s in it, not field names or raw enum values. `_meta`
  lists fields to leave out of a summary.
- Articles and keywords carry `allowed_mutations`: `{ verb: { allowed, reason } }`.
  Check it before acting. If `allowed` is false, tell the human the `reason`;
  do not retry.
- Articles carry `editor_url`. That is the link you hand a person.
- `null` means unknown or unmeasured. Say "unknown" or "—", never 0.

## Preflight (always)

1. `GET /auth/whoami` - confirms the key, lists workspaces, shows quota.
   CLI: `auth whoami`.
2. Pick the workspace. One workspace: use it. Several: ask the human which
   site unless the conversation makes it obvious.
3. `GET /workspaces/{id}` - integration status. No CMS connected means the
   human publishes by hand; say so if publishing comes up.
4. `GET /readiness?workspace_id=` - if the score is low, fixing readiness
   comes before writing more content. Walk the human through high-severity
   findings; each artifact has a placement instruction.

## Happy path

1. `GET /keywords?workspace_id=` - what is tracked. Prefer a keyword whose
   `allowed_mutations.generate_draft.allowed` is true.
2. If nothing fits, `POST /keywords/suggest { workspace_id, seeds?, limit? }`.
   This spends research credits: **ask before calling it**. Results are
   candidates, not saved.
3. Agree the keyword (and optionally a title) with the human.
4. `POST /articles/generate { workspace_id, keyword, title? }` - returns 202
   with `article_id`, `poll_url`, `editor_url`. Nothing is published.
5. Poll `GET /articles/{id}` every 30-60 s until `status` is `review`
   (about two minutes). `error` means the run failed; the `generation`
   block says why.
6. Tell the human: "Draft ready for review at {editor_url}." Then stop.
   Approval is theirs.

`GET /articles/{id}/content?format=markdown` gives you the body to read or
critique. Suggestions go to the human; you cannot edit through this API.

## Rules you never break

- Never attempt to publish, approve, schedule or delete. No endpoint does it;
  do not improvise one through the dashboard or the CMS.
- Never fabricate metrics. Volume, difficulty, scores and traffic come from
  the API or they do not exist. `null` is "unmeasured", not a number.
- Ask before spending: keyword suggestions cost research credits; each draft
  costs quota and model credits. Past the included volume, `generate` refuses
  unless `allow_overage: true` - only send that after the human said yes.
- One draft at a time per keyword. Do not queue several to "see which is best".
- Do not regenerate something a human has not read yet (`status: review`).

## Errors

| `error.code` | HTTP | Means | Do |
|---|---|---|---|
| `unauthorized` | 401 | Missing, malformed, unknown, expired or revoked key | Ask the human for a new key at `/settings/api-keys`; export `ALTORANK_API_KEY`; retry |
| `forbidden` | 403 | Key lacks the scope | Ask for a key with that scope |
| `not_found` | 404 | Id is not in this account | Re-list and use an id from the list |
| `invalid_request` | 400 | Bad or missing parameter | Fix the request per `agent_guidance` |
| `rate_limited` | 429 | Over 120 req/min for this key | Wait `Retry-After` seconds; batch reads |
| `quota_exceeded` | 402 | Free draft used, or included volume used | Tell the human; retry only after they choose a plan or approve overage |
| `not_available` | 409 | Action not possible in this state or on this install | Report the `reason`; do not retry |
| `upstream_error` | 502 | Third-party site or provider failed | Retry once, then report |
| `internal_error` | 500 | Unexpected | Retry once, then report the message verbatim |

Rate-limit headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
`X-RateLimit-Reset` (unix seconds), `Retry-After` on 429. The limit is per
running instance of the app, so treat it as a floor, not a contract.

## Endpoint index

| Method | Path | Scope |
|---|---|---|
| GET | `/auth/whoami` | read |
| GET | `/workspaces` | read |
| GET | `/workspaces/{id}` | read |
| GET | `/keywords?workspace_id=&status=&limit=` | read |
| POST | `/keywords/suggest` | read |
| GET | `/articles?workspace_id=&status=&limit=` | read |
| GET | `/articles/{id}` | read |
| GET | `/articles/{id}/content?format=` | read |
| POST | `/articles/generate` | generate |
| GET | `/readiness?workspace_id=` (or `?domain=`) | read |
| GET | `/usage` | read |

## Configuration

- `ALTORANK_API_KEY` - required for account calls. Precedence: `--api-key`
  flag, then this variable, then `~/.altorank/config.json` (`{"api_key": "..."}`).
- `ALTORANK_BASE_URL` - default `https://app.altorank.co`. Self-hosted installs
  set their own origin.
