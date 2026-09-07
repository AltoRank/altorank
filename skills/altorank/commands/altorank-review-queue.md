---
description: List the AltoRank drafts waiting for a human's review in a workspace, with their editor links
argument-hint: <workspace-id>
---

Argument: `$ARGUMENTS` is a workspace id. Run from `apps/web`:

```bash
npm run cli -- articles list --workspace <id> --status review
```

For each article give the title, the keyword and `editor_url`; that link is
what the human opens to approve. Use the labels in `_human` where present, not
raw field names. To read a draft's body:

```bash
npm run cli -- articles content <article_id> --format markdown
```

Wording suggestions go to the human. The only edit you can make yourself is a
literal find-and-replace (`articles replace <id> --find … --replace …`), which
previews until you add `--apply`, and only after the human has seen the hits.
