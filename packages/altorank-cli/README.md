# altorank

Command-line client for the [AltoRank](https://github.com/AltoRank/altorank)
agent API (`/api/agent/v1`). Every command prints one JSON envelope, errors
included, and exits 1 when `ok` is false, so a shell script or a coding agent
can act on the output without parsing anything else.

Nothing here publishes, approves or deletes: the API has no such calls, so
neither does this. `articles retry-publish` re-runs a publish a human already
approved and that failed; `articles replace` proposes unless you pass `--apply`.

## Install

```bash
npx altorank auth whoami        # one-off, nothing installed
npm i -g altorank               # or keep it around
altorank auth whoami
```

Node 20 or newer. No runtime dependencies.

## Auth

Create a key at `https://app.altorank.co/settings/api-keys` (or your own
install). The CLI looks for it in this order:

1. `--api-key <key>` on the command line
2. `ALTORANK_API_KEY` in the environment
3. `~/.altorank/config.json`, as `{"api_key": "altorank_live_…"}`

The base URL comes from `ALTORANK_BASE_URL`, then `base_url` in the same
config file, then `https://app.altorank.co`. Point it at your self-hosted
install to talk to that instead.

`altorank auth status` tells you which source it picked and whether the key
works.

Mutations (`replace --apply`, `bulk-*`, `retry-publish`, `pause`/`resume`)
need a key with the `write` scope; read-only keys get a `forbidden` envelope.

## Commands

```
altorank auth whoami
altorank auth status
altorank workspaces list
altorank workspaces get <id>
altorank workspaces pause <id> | resume <id>
altorank keywords list --workspace <id> [--status new] [--limit 50]
altorank keywords suggest --workspace <id> [--seeds "a,b"] [--limit 50]
altorank keywords export --workspace <id> [--format csv|json] [--status planned]
altorank keywords bulk-reschedule --workspace <id> --ids a,b --shift-days 7 | --json '{"items":[{"keyword_id":"…","date":"2026-10-01"}]}'
altorank keywords bulk-remove --workspace <id> --ids a,b
altorank articles list --workspace <id> [--status review]
altorank articles get <id>
altorank articles content <id> [--format markdown|html|tiptap]
altorank articles generate --workspace <id> --keyword "…" [--title "…"] [--article <id>] [--allow-overage] [--idempotency-key <key>]
altorank articles replace <id> --find "…" --replace "…" [--match-case] [--whole-word] [--apply]
altorank articles bulk-replace --workspace <id> --find "…" --replace "…" [--ids a,b] [--apply]
altorank articles retry-publish <id>
altorank gsc performance|cannibalization|coverage --workspace <id> [--days 28]
altorank gsc inspect --workspace <id> --url https://…
altorank readiness check --workspace <id> | --domain example.com
altorank usage
```

`--json-file path.json` works anywhere `--json` does. `keywords export
--format csv` prints the CSV itself instead of an envelope.

## Output

```json
{ "ok": true,  "data": { … }, "agent_guidance": "what to do next" }
{ "ok": false, "error": { "code": "unauthorized", "message": "…" }, "agent_guidance": "how to recover" }
```

`agent_guidance` is one or two sentences addressed to whoever is driving the
CLI, usually a coding agent: the next command on success, the fix on failure.

## Source

The CLI is built from
[`apps/web/scripts/cli.ts`](https://github.com/AltoRank/altorank/blob/main/apps/web/scripts/cli.ts)
in the AltoRank monorepo; this package only bundles it. There is one copy of
the source, shared with the MCP server and the HTTP routes.

```bash
npm run build -w packages/altorank-cli   # from the monorepo root
node packages/altorank-cli/dist/cli.js --help
```

AGPL-3.0-only, like the rest of AltoRank.
