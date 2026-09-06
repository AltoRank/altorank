import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { SCOPE_COOKIE } from "@/lib/workspace-scope";
import type { User } from "@supabase/supabase-js";

export interface AuthContext {
  user: User;
  agencyId: string;
  role: string;
}

/**
 * Require an authenticated user who belongs to an agency.
 * Throws if unauthenticated or not an agency member.
 *
 * Optionally pass `requiredRoles` to restrict to specific roles
 * (e.g. ["owner", "admin"]).
 */
export async function requireAuth(
  requiredRoles?: string[],
): Promise<AuthContext> {
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    throw new Error("Not authenticated");
  }

  // Not `.single()`: PostgREST refuses it when a user belongs to two agencies,
  // and accepting a second invitation locked that person out of every server
  // action (settings track, 2026-09-04). Oldest first, so the fallback below
  // is the same agency on every request rather than whichever row came back.
  const { data: members, error: membersError } = await supabase
    .from("agency_members")
    .select("agency_id, role")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });

  // A failed read is not an absent membership. Under load the pooled
  // connection times out, and reporting that as "no membership" sent people
  // to the wrong fix (re-invite) for a transient database error.
  if (membersError) {
    throw new Error(`Could not read your account membership: ${membersError.message}`);
  }
  if (!members?.length) {
    throw new Error("No agency membership found");
  }

  let member = members[0];
  if (members.length > 1) {
    // The agency of the workspace they are looking at, when the scope cookie
    // names one they can see. RLS scopes the lookup to their agencies, so a
    // foreign or stale id simply misses and the oldest membership stands.
    const scoped = (await cookies()).get(SCOPE_COOKIE)?.value;
    if (scoped && scoped !== "all") {
      const { data: ws } = await supabase
        .from("workspaces")
        .select("agency_id")
        .eq("id", scoped)
        .maybeSingle();
      const match = ws && members.find((m) => m.agency_id === ws.agency_id);
      if (match) member = match;
    }
  }

  if (requiredRoles && !requiredRoles.includes(member.role)) {
    throw new Error("Insufficient permissions");
  }

  return {
    user,
    agencyId: member.agency_id,
    role: member.role,
  };
}
