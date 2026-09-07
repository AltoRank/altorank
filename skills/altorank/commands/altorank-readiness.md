---
description: Run AltoRank's agent-readiness check on a workspace or a bare domain and walk the human through the high-severity findings
argument-hint: <workspace-id | domain>
---

Argument: `$ARGUMENTS` is a workspace id or a domain. Run from `apps/web`:

```bash
npm run cli -- readiness check --workspace <id>
# or, with no account key, any domain:
npm run cli -- readiness check --domain example.com
```

Summarise the score and the findings high severity first. Each artifact in the
result carries a placement instruction: hand it to the human with that
placement. You cannot change their site; do not offer to. If the score is low,
say that fixing readiness comes before writing more content.
