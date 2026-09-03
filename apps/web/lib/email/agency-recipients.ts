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
 * Every address that should hear about work on this agency's sites.
 *
 * Deduplicated and lowercased: one person on two memberships is one email, and
 * a duplicate send is worse than a missing one because it reads as a bug in the
 * product rather than in a mailing list.
 */
export async function agencyRecipients(
  supabase: SupabaseClient,
  agencyId: string,
): Promise<string[]> {
  const found = new Set<string>();
  try {
    const { data: members } = await supabase
      .from("agency_members")
      .select("user_id")
      .eq("agency_id", agencyId);

    for (const m of members ?? []) {
      const { data } = await supabase.auth.admin.getUserById(m.user_id as string);
      const email = data?.user?.email?.trim().toLowerCase();
      if (email) found.add(email);
    }
  } catch {
    return [];
  }
  return [...found];
}
