// ---------------------------------------------------------------------------
// The trial gate, asked on the server, and the article body it locks
// ---------------------------------------------------------------------------
//
// lib/billing/trial.ts decides the gate from a quota and an address. This is
// the half that fetches them, for the three kinds of caller that need the
// answer:
//
//   a signed-in request   sessionTrialGate: quota cached per request, so the
//                         dashboard layout and the page under it share one
//                         computation
//   anything else         accountTrialGate: the agent API (a key, no session),
//                         the onboarding worker's mail, a cron
//   a list of rows        lockArticleBodies: strips the body from every row
//                         whose account is gated
//
// The lock sits here, under the pages and routes, because a redirect in a
// layout is not a lock. Next renders a layout and its page separately and
// skips an unchanged layout on client navigation, so the page's own read is
// the only place a gated account can be refused every time.

import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getQuota } from "@/lib/billing/quota";
import { getRequestQuota } from "@/lib/queries/quota";
import { getSimulation } from "@/lib/dev/simulation";
import { createClient } from "@/lib/supabase/server";
import { trialGateState, type TrialGateState } from "@/lib/billing/trial";

/**
 * Every article column that carries the article's words or quotes them.
 *
 * `content` is the text itself. `meta_description` is written by the model
 * from it. `fact_checks` stores each checked sentence whole, `link_checks`
 * and `seo_checks`/`aeo_checks` carry anchors and notes lifted from it. What
 * stays is what the gate card is allowed to show: title, keyword, length,
 * status, scores.
 */
export const ARTICLE_BODY_COLUMNS = [
  "content",
  "meta_description",
  "fact_checks",
  "link_checks",
  "seo_checks",
  "aeo_checks",
] as const;

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

/** The signed-in user, once per request. The layout, the page and the lock all ask. */
const sessionUser = cache(async function sessionUser() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return data.user ?? null;
});

/**
 * Article rows as a signed-in page may render them: bodies stripped from
 * every row whose account is gated for this person.
 *
 * Decided per account, from each row's own workspace, because a person can
 * belong to a paying account and a gated one at once and the rows of one say
 * nothing about the other. The workspace-to-account map is read through the
 * caller's client, so RLS answers it.
 */
export async function lockArticleBodies<T extends { workspace_id?: string | null }>(rows: T[]): Promise<T[]> {
  if (!rows.length) return rows;
  const user = await sessionUser();
  // No session means RLS returned these rows to nobody in particular; there
  // is no account to ask about, and nothing readable should leave.
  if (!user) return rows.map((r) => withoutBody(r));

  const workspaceIds = [...new Set(rows.map((r) => r.workspace_id).filter((id): id is string => Boolean(id)))];
  const supabase = await createClient();
  const { data: workspaces, error } = await supabase.from("workspaces").select("id, account_id").in("id", workspaceIds);
  // Not knowing whose rows these are is not permission to show them.
  if (error) throw new Error(`article lock: could not read the rows' sites (${error.message})`);
  const accountOf = new Map((workspaces ?? []).map((w) => [w.id as string, w.account_id as string]));

  const locked = new Map<string, boolean>();
  for (const accountId of new Set(accountOf.values())) {
    locked.set(accountId, (await sessionTrialGate(accountId, user.email ?? null)) === "gated");
  }
  return rows.map((r) => {
    const accountId = r.workspace_id ? accountOf.get(r.workspace_id) : undefined;
    // A row whose site could not be placed is treated as locked, for the
    // same reason as the read error above.
    return accountId === undefined || locked.get(accountId) ? withoutBody(r) : r;
  });
}

/** The same for one row. Null in, null out. */
export async function lockArticleBody<T extends { workspace_id?: string | null }>(row: T | null): Promise<T | null> {
  if (!row) return row;
  const [out] = await lockArticleBodies([row]);
  return out ?? null;
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
