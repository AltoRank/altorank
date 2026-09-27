// ---------------------------------------------------------------------------
// Which workspace am I looking at?
// ---------------------------------------------------------------------------
//
// A workspace is a site. Every operational page in the product is about one:
// its keywords, its drafts, its backlinks, its analytics, its readiness. The
// pages were built to show all of them at once with a Workspace column, which
// reads as one big list rather than one site, and gets worse with every site
// added (2026-09-02).
//
// The scope is a cookie, not a URL parameter, so it survives navigation
// between sections: switching to a client on Keywords and clicking Articles
// should stay on that client. A URL parameter still wins when present, so a
// link can point at one workspace's view.

import { cache } from "react";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { sessionTrialGate } from "@/lib/billing/body-lock";

export const SCOPE_COOKIE = "active_workspace";

/** A site the caller can see, and the account that owns it. */
export type ScopedSite = { workspaceId: string; accountId: string };

type SiteRow = { id: string; account_id: string; name: string | null; domain: string | null };

/**
 * The caller's sites, oldest first, with the account each belongs to. RLS
 * scopes this to the caller's accounts, so a foreign id simply misses the
 * list. One read per request, shared by the scope and by `requireAuth`.
 */
const readSites = cache(async function readSites(): Promise<SiteRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("workspaces")
    .select("id, account_id, name, domain")
    .order("created_at", { ascending: true });
  // A dropped error here becomes an empty id list, which becomes a null scope,
  // which every page in the dashboard renders as "you have no sites yet":
  // Articles says "No workspaces yet. Add one", Linking says "Add a workspace
  // first", Improvements says "No workspace yet". One failed read and the app
  // tells an account with six sites to create its first.
  if (error) throw new Error(`workspace scope: could not read this account's sites (${error.message})`);
  return (data ?? []) as SiteRow[];
});

/**
 * The site to open when nothing names one: the oldest site of the first
 * account, oldest first, that the trial gate lets this person into.
 *
 * "The oldest site" alone was wrong for anyone in two accounts. A person
 * invited to a paying account who also owns an older, never-trialed one
 * landed on their own gated site with no cookie yet (an invitation's link
 * sets none), the dashboard sent them to the gate card, and nothing on it
 * led to the paying account: the account they were invited to work in was
 * unreachable without paying for the one they were not using (round-4
 * review). A person whose every account is gated still lands on the oldest
 * site, and its card is where they start the trial.
 *
 * Only asked when the sites span two accounts or more, so a single-account
 * person pays nothing for it; the quota each answer needs is the one the
 * dashboard layout reads anyway, cached per request.
 */
async function defaultSite(rows: SiteRow[]): Promise<SiteRow | null> {
  if (!rows.length) return null;
  const accounts = [...new Set(rows.map((r) => r.account_id))];
  if (accounts.length < 2) return rows[0];
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const email = data.user?.email ?? null;
  for (const accountId of accounts) {
    if ((await sessionTrialGate(accountId, email)) !== "gated") {
      return rows.find((r) => r.account_id === accountId) ?? rows[0];
    }
  }
  return rows[0];
}

/**
 * The site the caller is looking at and the account that owns it, or null
 * when they have no site.
 *
 * A valid cookie (or an explicit id) wins. Anything else - no cookie yet, a
 * cookie left over from when "all" existed, an id from another account -
 * falls back to `defaultSite`. There is no "all sites" scope: a merged view
 * of every site is what made Audits and Brand Voice show two domains at once
 * (2026-09-02).
 *
 * Validated against the caller's own sites every time: the cookie is
 * client-controlled, and an id from another account must never widen what a
 * query returns.
 *
 * This is the one answer to "which account is this person working in" for a
 * signed-in request. The dashboard layout's trial gate, `requireAuth` (and
 * through it every server action, key creation and OAuth consent) and the
 * spend gate all resolve the account from here or from the site being acted
 * on, never from whichever membership a query happened to return.
 */
export const getScope = cache(async function getScope(explicit?: string): Promise<ScopedSite | null> {
  const wanted = explicit ?? (await cookies()).get(SCOPE_COOKIE)?.value;
  const rows = await readSites();
  const chosen =
    (wanted && wanted !== "all" ? rows.find((r) => r.id === wanted) : undefined) ?? (await defaultSite(rows));
  return chosen ? { workspaceId: chosen.id, accountId: chosen.account_id } : null;
});

/**
 * The workspace the user is looking at. Null only when they have none.
 *
 * One read of the caller's sites, deduplicated per request, chosen in memory
 * (see `getScope`). It runs once in the dashboard layout and again in every
 * page inside it, so it sits at the head of every render's critical path.
 */
export const getScopedWorkspaceId = cache(async function getScopedWorkspaceId(
  explicit?: string,
): Promise<string | null> {
  return (await getScope(explicit))?.workspaceId ?? null;
});

/**
 * The caller's sites in accounts other than `accountId` that the trial gate
 * lets them into, oldest first: what the gate card offers as a way out for a
 * person who belongs to a paying account as well as a gated one.
 */
export async function openSitesOutside(accountId: string): Promise<Array<{ id: string; label: string }>> {
  const rows = (await readSites()).filter((r) => r.account_id !== accountId);
  if (!rows.length) return [];
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const email = data.user?.email ?? null;
  const open = new Map<string, boolean>();
  for (const accountId of new Set(rows.map((r) => r.account_id))) {
    open.set(accountId, (await sessionTrialGate(accountId, email)) !== "gated");
  }
  return rows
    .filter((r) => open.get(r.account_id))
    .map((r) => ({ id: r.id, label: r.domain || r.name || "Another site" }));
}
