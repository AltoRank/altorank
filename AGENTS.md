<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Scope: an account is not a workspace

A workspace is one site. An account is what owns several: the thing that signs
up, pays, and has members. (Named `agencies` until migration 085, 2026-09-09;
"Agency" is now only a plan tier.) RLS keeps
one customer out of another customer's data and stops there. Since migration
053 the workspace-scoped tables resolve through `user_workspace_ids()` rather
than `user_account_ids()`, so a member restricted to some workspaces
(`account_members.workspace_ids`) is held to them — but that column is `NULL`
for everyone by default, meaning "all of this account's workspaces". So the
practical outcome is unchanged: a query with no `workspace_id` filter still
returns every workspace in the signed-in account. It does not error, it does not
leak across customers, and on an account with one workspace it returns exactly
the same list as the correct query.

That is why seven of these reached production on 2026-09-03 — a sidebar badge
reading `4` beside a list of `2`, "Search Console connected" because a
*different* customer had connected it, dialogs filing a keyword under a workspace
the screen was not showing.

**Every read a page renders must name its workspace.** Scope comes from
`getScopedWorkspaceId()` on the server or `useWorkspace().active` on the
client. There is no "all workspaces" view by design.

The chrome is the part that gets forgotten: badges, counts, "Connected" pills,
nav-visibility gates and recent-item strips sit beside a correctly scoped main
query and quietly answer a different question. A dialog should *follow* the
sidebar switcher, never offer its own workspace picker.

Not everything is workspace-scoped. `accounts`, `account_members`,
`account_integrations`, `api_keys`, `backlink_exchanges`, `backlink_credits`,
`cancellation_feedback`, `invites` and `invoices` are account-level by design —
check the table has a `workspace_id` column before "fixing" it.

`lib/queries/__tests__/workspace-scope*.ts` fails the build on new instances,
including a call site that simply omits the argument. If it fires, read the
message: it tells you which line and why.
