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

export const SCOPE_COOKIE = "active_workspace";

/**
 * The workspace the user is looking at. Null only when they have none.
 *
 * There is no "all sites" scope. A visitor with no cookie yet, or a cookie
 * left over from when "all" existed, lands on their first site rather than on
 * a merged view of every site, which is what made Audits and Brand Voice show
 * two domains at once (2026-09-02).
 *
 * Validated against the caller's own workspaces every time: the cookie is
 * client-controlled, and an id from another account must never widen what a
 * query returns.
 *
 * One round trip, deduplicated per request. This used to be two sequential
 * queries (look the cookie up, then fall back to the oldest site), and it ran
 * once in the dashboard layout and again in every page inside it, so each
 * dashboard render paid for it twice at the head of its critical path. An
 * account's site list is short - it is what the switcher shows - so reading
 * the ids once and choosing in memory costs nothing and saves the second
 * query outright. `cache` keys on the argument; both callers pass none.
 */
export const getScopedWorkspaceId = cache(async function getScopedWorkspaceId(
  explicit?: string,
): Promise<string | null> {
  const wanted = explicit ?? (await cookies()).get(SCOPE_COOKIE)?.value;
  const supabase = await createClient();

  // RLS scopes this to the caller's agency, so a foreign id simply misses
  // the list. Oldest first, so the fallback is stable rather than whichever
  // row came back first.
  const { data } = await supabase
    .from("workspaces")
    .select("id")
    .order("created_at", { ascending: true });
  const ids = ((data ?? []) as Array<{ id: string }>).map((w) => w.id);

  if (wanted && wanted !== "all" && ids.includes(wanted)) return wanted;
  return ids[0] ?? null;
});
