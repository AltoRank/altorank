import type { SupabaseClient } from "@supabase/supabase-js";
import type { SiteScope } from "./access";

/**
 * Which sites this person holds on this account: NULL for every site, a list
 * for exactly those (`account_members.workspace_ids`, migration 053).
 *
 * Read with the person's own client - RLS shows a member their own row - and
 * fails closed: an unreadable or missing membership throws rather than being
 * taken for "every site", because every caller of this decides how far the
 * person may reach.
 */
export async function readMemberSites(
  asCaller: Pick<SupabaseClient, "from">,
  accountId: string,
  userId: string,
): Promise<SiteScope> {
  const { data, error } = await asCaller
    .from("account_members")
    .select("workspace_ids")
    .eq("account_id", accountId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`Could not read your access: ${error.message}`);
  if (!data) throw new Error("No account membership found");
  const sites = (data as { workspace_ids?: unknown }).workspace_ids;
  if (sites == null) return null;
  if (!Array.isArray(sites)) throw new Error("Could not read your access");
  return sites.filter((s): s is string => typeof s === "string");
}
