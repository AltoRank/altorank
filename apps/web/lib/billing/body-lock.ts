// ---------------------------------------------------------------------------
// The trial gate, asked on the server, and the article body it locks
// ---------------------------------------------------------------------------
//
// lib/billing/trial.ts decides the gate from a quota and an address. This is
// the half that fetches them, for the kinds of caller that need the answer:
//
//   a signed-in request   sessionTrialGate: quota cached per request, so the
//                         dashboard layout and the page under it share one
//                         computation
//   anything else         accountTrialGate: the agent API (a key, no session),
//                         the onboarding worker's mail, a cron
//   a page's rows         articlesForSession: reads the rows the caller's
//                         client returned, whole, and withholds the body from
//                         every row whose account is gated
//   an action on a body   articleBodyForSession: the one article's text, or
//                         the refusal
//
// The database is what makes this a lock. Migration 097 withholds the body
// columns from every client token, so the only way a body reaches a signed-in
// person is through a server read here, after the gate has answered
// (lib/articles/body-read.ts). Before 097 the app stripped the body after
// reading it through the person's own client, and the same person could ask
// PostgREST for it directly.
//
// The dashboard layout's redirect is the door, not the lock: Next skips an
// unchanged layout on client navigation, so the page's own read is where a
// gated account is refused every time.

import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getQuota } from "@/lib/billing/quota";
import { getRequestQuota } from "@/lib/queries/quota";
import { getSimulation } from "@/lib/dev/simulation";
import { createClient } from "@/lib/supabase/server";
import { trialGateState, type TrialGateState } from "@/lib/billing/trial";
import { BODY_LOCKED_MESSAGE } from "@/lib/billing/trial-refusal";
import { ARTICLE_BODY_COLUMNS, readArticlesWhole } from "@/lib/articles/body-read";

export { ARTICLE_BODY_COLUMNS };

/** The row with every body column nulled. Absent columns stay absent. */
export function withoutBody<T extends object>(row: T): T {
  const out = { ...row } as Record<string, unknown>;
  for (const column of ARTICLE_BODY_COLUMNS) {
    if (column in out) out[column] = null;
  }
  return out as T;
}

async function simulatedGate(): Promise<boolean> {
  // `cookies()` throws outside a request (a cron, a worker invocation). The
  // simulation is a dev-only cookie, so "no request" means "no simulation".
  try {
    return (await getSimulation())?.gate === true;
  } catch {
    return false;
  }
}

/**
 * The gate for the signed-in caller, on one of their accounts.
 *
 * `email` is the session's address, or null when the session has none; the
 * same value the dashboard layout hands getRequestQuota, so the cached quota
 * is the one it already computed.
 */
export async function sessionTrialGate(accountId: string, email: string | null): Promise<TrialGateState> {
  const [quota, simulated] = await Promise.all([getRequestQuota(accountId, email), simulatedGate()]);
  return trialGateState(quota, email, { simulated });
}

/**
 * The gate for an account, for a caller with its own client.
 *
 * `email` is whoever is asking: the person who created an API key, or null
 * for a cron or a mail, which getQuota reads as "no session" (and which the
 * bypass list never matches).
 */
export async function accountTrialGate(
  supabase: SupabaseClient,
  accountId: string,
  email: string | null,
): Promise<TrialGateState> {
  const [quota, simulated] = await Promise.all([getQuota(supabase, accountId, email), simulatedGate()]);
  return trialGateState(quota, email, { simulated });
}

/**
 * The gate for an account, for an API key.
 *
 * The account is asked about as nobody (`null`, the way the agent API's
 * generate route asks), so whether it is ours comes from who CREATED the
 * account (lib/billing/operator-account.ts) and never from who made the key.
 * Asking as the key's creator made a key an operator created while invited
 * into a customer's gated account read that account's article text for as
 * long as the key lived - after the operator left, and in whoever's hands the
 * key ended up (round-5 review). Being invited is not being the account.
 *
 * The bypass list is still asked about the key's creator: it is our own test
 * mailbox, and the one thing a bypassed address is for is reading the bodies
 * the gate would withhold.
 */
export async function keyTrialGate(
  supabase: SupabaseClient,
  accountId: string,
  keyCreatorEmail: string | null,
): Promise<TrialGateState> {
  const [quota, simulated] = await Promise.all([getQuota(supabase, accountId, null), simulatedGate()]);
  return trialGateState(quota, keyCreatorEmail, { simulated });
}

/**
 * The gate for the account a workspace belongs to, for a caller with no
 * session to speak for: the publisher, which the cron and the Publish button
 * both reach. A site whose account cannot be read throws - an unknown is not
 * an open gate.
 */
export async function workspaceTrialGate(supabase: SupabaseClient, workspaceId: string): Promise<TrialGateState> {
  const { data, error } = await supabase.from("workspaces").select("account_id").eq("id", workspaceId).maybeSingle();
  if (error) throw new Error(`trial gate: could not read the site's account (${error.message})`);
  if (!data?.account_id) throw new Error("trial gate: this site has no account");
  return accountTrialGate(supabase, data.account_id as string, null);
}

/** The signed-in user, once per request. The layout, the page and the lock all ask. */
const sessionUser = cache(async function sessionUser() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return data.user ?? null;
});

/**
 * A row as the caller's own client returned it. The id is the permission:
 * only the caller's client may produce it, so that RLS decides which rows.
 */
export type VisibleArticle = { id: string };

/**
 * Which of these sites' accounts withhold the body from the signed-in person.
 *
 * Decided per account, because a person can belong to a paying account and a
 * gated one at once and the rows of one say nothing about the other. The
 * site-to-account map is read through the caller's client, so RLS answers it.
 * A site that cannot be placed, and every site when nobody is signed in,
 * counts as locked: not knowing whose rows these are is not permission to
 * show them.
 */
async function lockedSites(workspaceIds: string[]): Promise<(workspaceId: string | null | undefined) => boolean> {
  const user = await sessionUser();
  if (!user) return () => true;

  const ids = [...new Set(workspaceIds.filter(Boolean))];
  if (!ids.length) return () => true;
  const supabase = await createClient();
  const { data: workspaces, error } = await supabase.from("workspaces").select("id, account_id").in("id", ids);
  if (error) throw new Error(`article lock: could not read the rows' sites (${error.message})`);
  const accountOf = new Map((workspaces ?? []).map((w) => [w.id as string, w.account_id as string]));

  const lockedAccount = new Map<string, boolean>();
  for (const accountId of new Set(accountOf.values())) {
    lockedAccount.set(accountId, (await sessionTrialGate(accountId, user.email ?? null)) === "gated");
  }
  return (workspaceId) => {
    const accountId = workspaceId ? accountOf.get(workspaceId) : undefined;
    return accountId === undefined || lockedAccount.get(accountId) !== false;
  };
}

/**
 * Article rows as a signed-in page may render them.
 *
 * `visible` is what the caller's own client returned, in the order the page
 * wants, so RLS has already decided which rows. The client selects ids and
 * not `*`: `*` names the body columns, which a client token may no longer
 * read (migration 097). The rows are read whole here with the service role,
 * and the body is withheld from every row whose account is gated for this
 * person.
 */
export async function articlesForSession<T extends object = Record<string, unknown>>(
  visible: VisibleArticle[],
): Promise<T[]> {
  if (!visible.length) return [];
  const rows = await readArticlesWhole<T & { workspace_id?: string | null }>(visible.map((r) => r.id));
  const locked = await lockedSites(rows.map((r) => r.workspace_id ?? ""));
  return rows.map((r) => (locked(r.workspace_id) ? withoutBody(r) : r));
}

/** The same for one row. Null in, null out. */
export async function articleForSession<T extends object = Record<string, unknown>>(
  visible: VisibleArticle | null,
): Promise<T | null> {
  if (!visible) return null;
  const [out] = await articlesForSession<T>([visible]);
  return out ?? null;
}

/**
 * One article's text for the signed-in caller, for an action that works on
 * it: score it, rewrite a field, fact-check it before approval, read a page
 * to brief a refresh.
 *
 * Throws "Article not found" when the caller's client cannot see it, and
 * BODY_LOCKED_MESSAGE when its account is gated for them. `columns` is a
 * PostgREST select list; the row is read with the service role only after
 * both answers.
 */
export async function articleBodyForSession<T = Record<string, unknown>>(
  articleId: string,
  columns: string = "*",
): Promise<T> {
  const supabase = await createClient();
  const { data: seen, error } = await supabase
    .from("articles")
    .select("id, workspace_id")
    .eq("id", articleId)
    .maybeSingle();
  if (error) throw new Error(`article read: could not check the article (${error.message})`);
  if (!seen) throw new Error("Article not found");
  if (await sessionBodyLockedForWorkspace(seen.workspace_id as string)) throw new Error(BODY_LOCKED_MESSAGE);
  const [row] = await readArticlesWhole<T>([articleId], columns);
  if (!row) throw new Error("Article not found");
  return row;
}

/**
 * Whether the signed-in caller may read bodies in this workspace's account.
 * For routes and actions that hand one article's text back.
 */
export async function sessionBodyLockedForWorkspace(workspaceId: string): Promise<boolean> {
  const user = await sessionUser();
  if (!user) return true;
  const supabase = await createClient();
  const { data: ws, error } = await supabase.from("workspaces").select("account_id").eq("id", workspaceId).maybeSingle();
  if (error) throw new Error(`article lock: could not read the site (${error.message})`);
  if (!ws) return true;
  return (await sessionTrialGate(ws.account_id as string, user.email ?? null)) === "gated";
}
