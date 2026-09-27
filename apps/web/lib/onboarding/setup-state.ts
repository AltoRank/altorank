// ---------------------------------------------------------------------------
// Has this person finished setup somewhere else?
// ---------------------------------------------------------------------------
//
// "Setup never finished" is a fact about a site: its wizard was neither
// finished nor skipped (`onboarded_at`, `onboarding_skipped_at`). The email
// that says so is read by a person, and a person can have more than one site -
// or more than one account, which is how a real signup (2026-09-22) got it:
// a second submit of the signup form made a second account and a second,
// empty site for the same domain before #237 made that submit reuse the
// first. The first site finished setup and had its draft; the empty twin
// never would, and the next night's sweep told the person their setup had
// never finished, about a site they did not know they had.
//
// So the email asks about the person, not only the site: if anybody this
// site's email would reach has finished setup on another site, or has an
// article on one, they know where setup is and the email is noise. The site
// the email is about is left out of the check, because its own draft is what
// the email carries.

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * True when a member of this site's account has, on any other site of any
 * account they belong to, finished or skipped setup, or has an article.
 *
 * Reads with the caller's client, which for every caller is the service
 * role: the crons. A failed read throws - the callers are sending an email,
 * and an unknown is not a reason to send it.
 */
export async function setupFinishedElsewhere(
  supabase: SupabaseClient,
  accountId: string,
  workspaceId: string,
): Promise<boolean> {
  const { data: members, error: membersError } = await supabase
    .from("account_members")
    .select("user_id")
    .eq("account_id", accountId);
  if (membersError) throw new Error(`could not read the account's members: ${membersError.message}`);
  const userIds = [...new Set((members ?? []).map((m) => m.user_id as string).filter(Boolean))];
  if (!userIds.length) return false;

  const { data: memberships, error: membershipsError } = await supabase
    .from("account_members")
    .select("account_id")
    .in("user_id", userIds);
  if (membershipsError) throw new Error(`could not read the members' accounts: ${membershipsError.message}`);
  const accountIds = [...new Set([accountId, ...(memberships ?? []).map((m) => m.account_id as string).filter(Boolean)])];

  const { data: sites, error: sitesError } = await supabase
    .from("workspaces")
    .select("id, onboarded_at, onboarding_skipped_at")
    .in("account_id", accountIds)
    .neq("id", workspaceId);
  if (sitesError) throw new Error(`could not read the members' sites: ${sitesError.message}`);
  const others = (sites ?? []) as Array<{ id: string; onboarded_at: string | null; onboarding_skipped_at: string | null }>;
  if (others.some((s) => s.onboarded_at || s.onboarding_skipped_at)) return true;
  if (!others.length) return false;

  // A draft whose run died (`error`) is nothing the person has seen.
  const { count, error: articlesError } = await supabase
    .from("articles")
    .select("id", { count: "exact", head: true })
    .in("workspace_id", others.map((s) => s.id))
    .neq("status", "error");
  if (articlesError) throw new Error(`could not count the members' articles: ${articlesError.message}`);
  return (count ?? 0) > 0;
}
