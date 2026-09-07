---
description: Check the AltoRank API key and list the workspaces it can reach (the preflight every other AltoRank command assumes)
---

Run, from `apps/web` of the AltoRank checkout:

```bash
npm run cli -- auth status
npm run cli -- workspaces list
```

Read `agent_guidance` in each envelope first. If `auth status` returns
`unauthorized`, ask the human for a key from `/settings/api-keys` and export it
as `ALTORANK_API_KEY`; do not guess one. With several workspaces, ask which one
unless the conversation already says. Report the workspace id, name and quota
in plain words; `null` is "unknown", never 0.
