<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Scope: an agency is not a workspace

A workspace is one site. An agency is the account that owns several. RLS
enforces the *agency* boundary and nothing else: every policy resolves through
`user_agency_ids()`, so a query with no `workspace_id` filter still returns
only the signed-in account's rows. It does not error, it does not leak across
customers, and on an account with one site it returns exactly the same list as
the correct query.

That is why seven of these reached production on 2026-09-03 — a sidebar badge
reading `4` beside a list of `2`, "Search Console connected" because a
*different* client had connected it, dialogs filing a keyword under a site the
screen was not showing.

**Every read a page renders must name its workspace.** Scope comes from
`getScopedWorkspaceId()` on the server or `useWorkspace().active` on the
client. There is no "all sites" view by design.

The chrome is the part that gets forgotten: badges, counts, "Connected" pills,
nav-visibility gates and recent-item strips sit beside a correctly scoped main
query and quietly answer a different question. A dialog should *follow* the
sidebar switcher, never offer its own workspace picker.

Not everything is workspace-scoped. `backlink_exchanges`, `invoices`,
`invites` and `backlink_credits` are agency-level by design — check the table
has a `workspace_id` column before "fixing" it.

`lib/queries/__tests__/workspace-scope*.ts` fails the build on new instances,
including a call site that simply omits the argument. If it fires, read the
message: it tells you which line and why.
