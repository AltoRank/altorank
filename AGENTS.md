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

# Search Console: one reader

`analytics_metrics` holds Search Console in four row shapes a day (total,
query, page, query_page; `apps/web/lib/gsc/analysis.ts`), and the same click is
in every one of them. A filter that lets a second shape through doubles a
number; no filter quadruples it. PostgREST also stops every response at 1,000
rows and says nothing. Both mistakes shipped more than once, the last time in
the client report.

**Read Search Console with `readGsc()` from `apps/web/lib/gsc/read.ts`.** Name
the shapes you need, read the partition you asked for, and hand it to an
analysis function that takes that partition; it pages past the cap for you.
Freshness is `latestGscDate()` / `lastGscWriteAt()`. GA4 and Bing share the
table and are not Search Console: pin their `source` in the same chain, and
page the read with `readAllPages()` (`apps/web/lib/supabase/read-all.ts`).

`lib/gsc/__tests__/read-guard.test.ts` parses every file in `apps/web` and
fails the build on: any other `.from("analytics_metrics")` that is not an
allowlisted writer or paged GA4/Bing reader; the table's name in any other
string (a variable, a REST URL, SQL); a `readGsc` call holding more than one
shape without a listed reason, since two partitions added together double the
number and no type can stop that; and a migration that reads the table in a
view, function or anything else that is not DDL on it.
