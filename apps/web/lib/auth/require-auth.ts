import { createClient } from "@/lib/supabase/server";
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

  const { data: member } = await supabase
    .from("agency_members")
    .select("agency_id, role")
    .eq("user_id", user.id)
    .single();

  if (!member) {
    throw new Error("No agency membership found");
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
