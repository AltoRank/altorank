import { createClient } from "@/lib/supabase/server";
import { getScope } from "@/lib/workspace-scope";
import type { User } from "@supabase/supabase-js";

export interface AuthContext {
  user: User;
  accountId: string;
  role: string;
}

/**
 * Require an authenticated user who belongs to an account.
 * Throws if unauthenticated or not an account member.
 *
 * Optionally pass `requiredRoles` to restrict to specific roles
 * (e.g. ["owner", "admin"]).
 *
 * Pass `workspaceId` when the call acts on one site: the account is then the
 * one that owns that site, and the role is the person's role there. Without
 * it, the account is the one that owns the site in scope. Either way it is
 * never an arbitrary membership, so the trial gate, the spend gate and the
 * plan checks behind an action are asked about the account the work belongs
 * to - for a person in a paying account and a gated one, that is the
 * difference between doing their job and being told to start a trial.
 */
export async function requireAuth(
  requiredRoles?: string[],
  opts: { workspaceId?: string } = {},
): Promise<AuthContext> {
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    throw new Error("Not authenticated");
  }

  // Not `.single()`: PostgREST refuses it when a user belongs to two accounts,
  // and accepting a second invitation locked that person out of every server
  // action (settings track, 2026-09-04). Oldest first, so the fallback below
  // is the same account on every request rather than whichever row came back.
  const { data: members, error: membersError } = await supabase
    .from("account_members")
    .select("account_id, role")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });

  // A failed read is not an absent membership. Under load the pooled
  // connection times out, and reporting that as "no membership" sent people
  // to the wrong fix (re-invite) for a transient database error.
  if (membersError) {
    throw new Error(`Could not read your account membership: ${membersError.message}`);
  }
  if (!members?.length) {
    throw new Error("No account membership found");
  }

  let member = members[0];
  if (opts.workspaceId) {
    // RLS answers this: a site in none of the person's accounts is not found.
    const { data: site, error: siteError } = await supabase
      .from("workspaces")
      .select("account_id")
      .eq("id", opts.workspaceId)
      .maybeSingle();
    if (siteError) throw new Error(`Could not read that site: ${siteError.message}`);
    const match = site && members.find((m) => m.account_id === site.account_id);
    if (!match) throw new Error("Workspace not found");
    member = match;
  } else if (members.length > 1) {
    // The account of the site they are working on - the same scope the
    // dashboard layout and every page answer for (lib/workspace-scope.ts). It
    // used to be the scope cookie's site or else the OLDEST MEMBERSHIP, while
    // the dashboard fell back to the oldest SITE, and for a person in two
    // accounts those were different accounts: the dashboard opened on the
    // paying site while every action, key creation and OAuth consent asked
    // the trial gate about their own never-trialed account and refused
    // (round-4 review). The oldest membership stands only when they can see
    // no site at all.
    const scope = await getScope();
    const match = scope && members.find((m) => m.account_id === scope.accountId);
    if (match) member = match;
  }

  if (requiredRoles && !requiredRoles.includes(member.role)) {
    throw new Error("Insufficient permissions");
  }

  return {
    user,
    accountId: member.account_id,
    role: member.role,
  };
}
