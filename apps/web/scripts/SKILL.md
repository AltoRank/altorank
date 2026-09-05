---
name: altorank
description: Drive AltoRank from a coding agent - audit a site's agent readiness, read Search Console, find keywords, write SEO drafts into a human's review queue, move the content plan, edit drafts by find-and-replace. Never publishes or approves.
---

# AltoRank for coding agents

AltoRank writes search and AI-search content for websites. You can read an
account, create **drafts**, move planned keywords on the calendar, edit a draft
by find-and-replace, and pause or resume a site. A person reviews, approves and
publishes in the editor. There is no publish, approve or delete call in this
API, and you must not look for a way around that. (`retry-publish` is the one
exception in name only: it re-runs a publish a human already approved and
that failed; it cannot publish anything else.)

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
critique. Wording suggestions go to the human. The one edit you can make is a
literal find-and-replace (`POST /articles/{id}/replace`), and it proposes first.

## Mutations (need the `write` scope)

Every mutation follows the same shape: **inspect, propose, confirm, write**.
The routes return the standard envelope; `_human` (when present) is how to
describe what happened to a person.

| Do | Call | Notes |
|---|---|---|
| Move planned keywords | `POST /keywords/bulk-reschedule` `{ workspace_id, items:[{keyword_id,date}] }` or `{ workspace_id, keyword_ids, shift_days }` | Only unwritten planned entries move; `planned_for` on `GET /keywords` shows the current day. Per-keyword outcomes, never all-or-nothing. |
| Take keywords off the plan | `POST /keywords/bulk-remove` `{ workspace_id, keyword_ids }` | Same as the planner's Remove: the calendar entry goes, the keyword stays tracked and is marked excluded. Nothing is deleted. |
| Export keywords | `GET /keywords/export?workspace_id=&format=csv\|json` | `csv` returns a file, not an envelope. Empty cells are unmeasured, never 0. |
| Find-and-replace in a draft | `POST /articles/{id}/replace` `{ find, replace, match_case?, whole_word?, preview_only? }` | **`preview_only` defaults to true.** Show the human the hits (before → after); only then resend with `preview_only: false`. Status never changes. Refused on approved, scheduled, live. |
| …across drafts | `POST /articles/bulk-replace` `{ workspace_id, find, replace, article_ids?, preview_only? }` | Capped at 10 articles. Approved/scheduled/live are skipped with the reason, never edited. |
| Retry a failed publish | `POST /articles/{id}/retry-publish` | Only when `GET /articles/{id}` shows `allowed_mutations.retry_publish.allowed: true` (approved + last publish failed). Otherwise refused; a human must approve. Tell the human before calling. |
| Pause / resume a site | `POST /workspaces/{id}/pause`, `POST /workspaces/{id}/resume` | Pause stops drafting and publishing; drafts, plan and pace stay. Resume re-plans from today. Cannot lift the account-wide billing pause. |

Mutations share a second limit of 30 a minute per key on top of the 120/min.
`X-RateLimit-Mutations-*` headers say where you stand.

## Search Console (read-only, stored data)

`GET /gsc/performance`, `/gsc/cannibalization`, `/gsc/coverage` and
`/gsc/url-inspection?url=` (all `?workspace_id=`, optional `&days=`) serve the
rows the nightly sync already stored - the same numbers the dashboard shows.
Nothing calls Google. Two states you must keep apart:

- **Not connected** → `ok: false`, `not_available`. There is no data. Do not
  say "no traffic"; say Search Console is not connected and a human connects it
  on the Integrations page.
- **Connected, nothing synced yet** → `ok: true` with `has_data: false`. Say the
  numbers are not in yet.

`changePct: null` means no baseline, not no change. `bucket: "unknown"` on
coverage means nobody asked Google, not "not indexed". A fresh URL inspection is
the human's click ("Check indexing") in the editor.

## Rules you never break

- Never attempt to publish, approve, schedule or delete. No endpoint does it;
  do not improvise one through the dashboard or the CMS. `retry-publish` only
  re-runs a publish a human already approved and that failed.
- Propose before you write. `replace` and `bulk-replace` default to
  `preview_only: true`; show the hits, get a yes, then write. Never send
  `preview_only: false` on the first call.
- Do not edit an approved article. The API refuses; do not ask the human to
  "request changes" just so you can edit unless they raised the change.
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
| `forbidden` | 403 | Key lacks the scope (mutations need `write`) | Ask for a key created with "Allow edits" ticked |
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
| POST | `/articles/{id}/replace` | write |
| POST | `/articles/bulk-replace` | write |
| POST | `/articles/{id}/retry-publish` | write |
| POST | `/keywords/bulk-reschedule` | write |
| POST | `/keywords/bulk-remove` | write |
| GET | `/keywords/export?workspace_id=&format=csv\|json` | read |
| GET | `/gsc/performance?workspace_id=&days=` | read |
| GET | `/gsc/cannibalization?workspace_id=&days=&min_impressions=&limit=` | read |
| GET | `/gsc/coverage?workspace_id=&days=&bucket=` | read |
| GET | `/gsc/url-inspection?workspace_id=&url=` | read |
| POST | `/workspaces/{id}/pause` | write |
| POST | `/workspaces/{id}/resume` | write |
| GET | `/readiness?workspace_id=` (or `?domain=`) | read |
| GET | `/usage` | read |

CLI equivalents: `keywords export|bulk-reschedule|bulk-remove`,
`articles replace|bulk-replace|retry-publish`, `workspaces pause|resume`,
`gsc performance|cannibalization|coverage|inspect`. `replace` writes only with
`--apply`.

## Configuration

- `ALTORANK_API_KEY` - required for account calls. Precedence: `--api-key`
  flag, then this variable, then `~/.altorank/config.json` (`{"api_key": "..."}`).
- `ALTORANK_BASE_URL` - default `https://app.altorank.co`. Self-hosted installs
  set their own origin.
