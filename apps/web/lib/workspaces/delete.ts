import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Deleting a workspace
// ---------------------------------------------------------------------------
//
// Plans cap the number of workspaces (lib/billing/workspaces.ts) and the cap
// counts every row whatever its status, so pausing a site never freed a slot.
// Until this existed there was no way to remove one at all: an account that
// typed the wrong domain, or an agency whose client left, stayed at its cap.
//
// Deleting takes the site's articles, keywords, calendar, reports and
// connections with it by cascade. It cannot be undone, so the person types the
// site's domain to confirm, and the check is made here as well as in the
// dialog. Owners and admins only: migration 072's delete policy says the same.
// The account's free-draft counter is not touched (lib/billing/free-drafts.ts),
// so deleting a site and adding it again does not hand back drafts.

export type DeleteWorkspaceResult = { ok: true } | { ok: false; message: string };

/** What the person must type: the domain, else the name for a site without one. */
export function deleteConfirmationText(site: { domain: string | null; name: string }): string {
  return (site.domain ?? "").trim() || site.name.trim();
}

function normalise(s: string): string {
  return s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
}

export async function deleteWorkspaceForAccount(
  supabase: SupabaseClient,
  accountId: string,
  workspaceId: string,
  typed: string,
): Promise<DeleteWorkspaceResult> {
  const { data: site, error: readError } = await supabase
    .from("workspaces")
    .select("id, name, domain")
    .eq("id", workspaceId)
    .eq("account_id", accountId)
    .maybeSingle();
  if (readError) return { ok: false, message: `Could not read that workspace: ${readError.message}` };
  if (!site) return { ok: false, message: "That workspace is not on this account." };

  const expected = deleteConfirmationText(site as { domain: string | null; name: string });
  if (normalise(typed) !== normalise(expected)) {
    return { ok: false, message: `Type ${expected} to confirm.` };
  }

  const { data: deleted, error } = await supabase
    .from("workspaces")
    .delete()
    .eq("id", workspaceId)
    .eq("account_id", accountId)
    .select("id");
  if (error) {
    // 23503: a row elsewhere still points at this site without a cascade.
    if (error.code === "23503") {
      return { ok: false, message: "This workspace is still referenced by a link exchange, so it cannot be deleted yet. Contact support." };
    }
    return { ok: false, message: `Could not delete the workspace: ${error.message}` };
  }
  // RLS turns a refused delete into zero rows, not an error.
  if (!deleted?.length) return { ok: false, message: "Only owners and admins can delete a workspace." };
  return { ok: true };
}
