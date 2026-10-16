---
description: Generate one AltoRank draft for an agreed keyword and hand the human the editor link. Never publishes or approves.
argument-hint: <workspace-id> <keyword> [title]
---

Argument: `$ARGUMENTS` is a workspace id and the keyword the human agreed to,
optionally a title. Before running, confirm the keyword with the human and make
up one idempotency key (a UUID) for this draft. Run from `apps/web`:

```bash
npm run cli -- articles generate --workspace <id> --keyword "<keyword>" [--keyword-id <id>] [--title "<title>"] --idempotency-key <uuid>
```

When the keyword is one the workspace already tracks (`npm run cli --
keywords list --workspace <id>`), pass its `id` as `--keyword-id`, so the
draft is briefed from that keyword and linked to it.

The API answers 202 with `article_id`, `poll_url` and `editor_url`. Poll every
30-60 seconds until `status` is `review` (about two minutes):

```bash
npm run cli -- articles get <article_id>
```

Then tell the human: "Draft ready for review at {editor_url}." and stop.
Approval is theirs. Rules:

- A timeout is not a failure. Repeat the call with the **same** idempotency
  key; you get the draft that already started, not a second one.
- One draft per keyword. Do not queue several to compare.
- `quota_exceeded` has two meanings; read the message. With no plan yet, the
  one-time free drafts are used: they do not reset and no overage can be
  bought, so tell the human to choose a plan on the Billing page and do not
  retry. On a plan, this month's included drafts are used: ask the human
  whether to pay overage for this one, and send `--allow-overage` only after
  they said yes.
