import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Who may set the account's Google consent
// ---------------------------------------------------------------------------
//
// `account_integrations` holds one Google consent per account, and it is what
// /connect/google lists Search Console properties with, for every site on the
// account. Members may only read it (migration 033 gives the table a SELECT
// policy and nothing else), so the OAuth callback writes it with the service
// role, and this is the check that stands in for the policy it does not have:
// the person sees every site on the account (`workspace_ids` NULL, migration
// 053). A member scoped to one client still connects that client's Search
// Console from the site's own button; what they cannot do is replace the
// consent the rest of the account's sites are listed with.

/** Why an account-level connect was refused, in the words /connect shows. */
export const ACCOUNT_CONSENT_REFUSED =
  "Connecting Google for the whole account needs access to every site on it. Connect Search Console from your site's settings instead.";

/**
 * Whether this person sees every site on the account. Read with the person's
 * own client: RLS shows a member their own membership row.
 */
export async function seesEverySite(
  asCaller: Pick<SupabaseClient, "from">,
  userId: string,
  accountId: string,
): Promise<boolean> {
  const { data, error } = await asCaller
    .from("account_members")
    .select("workspace_ids")
    .eq("account_id", accountId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return false;
  return (data as { workspace_ids?: unknown }).workspace_ids == null;
}
