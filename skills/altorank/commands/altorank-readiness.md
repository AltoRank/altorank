---
description: Run AltoRank's agent-readiness check on a workspace or a bare domain and walk the human through the high-severity findings
argument-hint: <workspace-id | domain>
---

Argument: `$ARGUMENTS` is a workspace id or a domain. Run from `apps/web`:

```bash
# with an API key: a workspace, or any domain
npm run cli -- readiness check --workspace <id>
npm run cli -- readiness check --domain example.com
# with no API key, any domain (runs the checks locally):
npm run readiness -- example.com --json
```

The local MCP server (`npm run mcp` from `apps/web`) also runs these checks
with no key, through `altorank_check_readiness` and `altorank_readiness_report`.

Summarise the score and the findings high severity first. Each artifact in the
result carries a placement instruction: hand it to the human with that
placement. You cannot change their site; do not offer to. If the score is low,
say that fixing readiness comes before writing more content.
