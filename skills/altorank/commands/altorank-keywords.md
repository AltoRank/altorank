---
description: List the keywords AltoRank tracks for a workspace and, with the human's yes, ask for new suggestions (spends research credits)
argument-hint: <workspace-id> [seed, seed]
---

Argument: `$ARGUMENTS` is a workspace id, optionally followed by comma-separated
seed terms. Run from `apps/web`:

```bash
npm run cli -- keywords list --workspace <id> [--status new] [--limit 50]
```

Prefer a keyword whose `allowed_mutations.generate_draft.allowed` is true. Only
if nothing fits, and only after the human says yes (this spends research
credits):

```bash
npm run cli -- keywords suggest --workspace <id> [--seeds "a,b"] [--limit 50]
```

Suggestions are candidates, not saved keywords. Volume and difficulty come from
the response or they do not exist; `null` is "unmeasured".
