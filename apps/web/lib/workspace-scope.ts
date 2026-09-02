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
 */
export async function getScopedWorkspaceId(explicit?: string): Promise<string | null> {
  const wanted = explicit ?? (await cookies()).get(SCOPE_COOKIE)?.value;
  const supabase = await createClient();

  if (wanted && wanted !== "all") {
    // RLS scopes this to the caller's agency, so a foreign id simply misses.
    const { data } = await supabase.from("workspaces").select("id").eq("id", wanted).maybeSingle();
    if (data?.id) return data.id;
  }

  // Oldest first, so the fallback is stable rather than whichever row came
  // back first.
  const { data: first } = await supabase
    .from("workspaces")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return first?.id ?? null;
}
