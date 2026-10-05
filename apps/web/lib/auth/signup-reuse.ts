// ---------------------------------------------------------------------------
// What a second signup submit already has
// ---------------------------------------------------------------------------
//
// `generateLink({ type: "signup" })` returns the EXISTING user while that user
// is unconfirmed, so a double click on "Create account", or a second try by
// someone who has not found the confirmation email yet, reaches the account
// and workspace inserts with a user those inserts already ran for.
// A real signup, 2026-09-22: one person, two accounts and two workspaces,
// eight seconds apart; the second workspace empty and on the English/US
// defaults, so the dashboard could open on the wrong one.
//
// The signup action asks this first and creates only what is missing.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface ExistingSignup {
  /** The account this user already belongs to, when a first submit got that far. */
  accountId: string | null;
  /** The workspace that account already has for this domain. */
  workspaceId: string | null;
}

export async function existingSignup(
  admin: SupabaseClient,
  userId: string,
  domain: string | null,
): Promise<ExistingSignup> {
  const { data: member } = await admin
    .from("account_members")
    .select("account_id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  const accountId = (member?.account_id as string | undefined) ?? null;
  if (!accountId || !domain) return { accountId, workspaceId: null };
  const { data: site } = await admin
    .from("workspaces")
    .select("id")
    .eq("account_id", accountId)
    .eq("domain", domain)
    .limit(1)
    .maybeSingle();
  return { accountId, workspaceId: (site?.id as string | undefined) ?? null };
}
