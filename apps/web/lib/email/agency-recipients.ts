// ---------------------------------------------------------------------------
// Who to tell, for an agency
// ---------------------------------------------------------------------------
//
// `agency_members` holds user ids, not addresses; the addresses live in
// `auth.users`, which PostgREST does not expose. So resolution goes through
// `auth.admin.getUserById`, one call per member, exactly as
// lib/billing/operator-agency.ts does for the operator check.
//
// Service role only. On a cookie-bound client `auth.admin` throws, and this
// returns nobody rather than an exception - a notification is not worth failing
// the work it is announcing.

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Every address that should hear about work on one of this agency's sites.
 *
 * Scoped to the workspace, like the pages are. `agency_members.workspace_ids`
 * (053) is NULL for a member who sees every site and an array for one who
 * sees only the listed ones; RLS reads it through `user_workspace_ids()`.
 * Until 2026-09-06 this ignored it and the draft-ready mail carried site B's
 * keyword, title and link to an editor restricted to site A. Same rule as the
 * predicate: NULL is everyone, an array must contain the workspace, and an
 * empty array is nobody.
 *
 * Deduplicated and lowercased: one person on two memberships is one email, and
 * a duplicate send is worse than a missing one because it reads as a bug in the
 * product rather than in a mailing list.
 */
export async function agencyRecipients(
  supabase: SupabaseClient,
  agencyId: string,
  workspaceId: string,
): Promise<string[]> {
  const found = new Set<string>();
  try {
    const { data: members } = await supabase
      .from("agency_members")
      .select("user_id, workspace_ids")
      .eq("agency_id", agencyId);

    for (const m of members ?? []) {
      if (!canSeeWorkspace(m.workspace_ids as string[] | null | undefined, workspaceId)) continue;
      const { data } = await supabase.auth.admin.getUserById(m.user_id as string);
      const email = data?.user?.email?.trim().toLowerCase();
      if (email) found.add(email);
    }
  } catch {
    return [];
  }
  return [...found];
}

/** Mirrors `user_workspace_ids()` in 053: NULL is every site, an array is exactly those. */
export function canSeeWorkspace(workspaceIds: string[] | null | undefined, workspaceId: string): boolean {
  if (workspaceIds == null) return true;
  return workspaceIds.includes(workspaceId);
}
