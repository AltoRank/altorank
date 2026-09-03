"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { encrypt } from "@/lib/crypto";
import { listBingSites, matchBingSite } from "@/lib/bing/webmaster";
import { syncBingWorkspace } from "@/lib/bing/sync";

export type BingConnectState =
  | { ok: true; siteUrl: string; rows: number; from: string | null; warning?: string }
  | { ok: false; error: string }
  | null;

/**
 * Connect Bing Webmaster Tools to one workspace with the account's API key.
 *
 * The key is checked by asking Bing which sites it can see, then matched to
 * the workspace's domain; a key that works but owns no site for the domain is
 * refused with the list of what it does own, so the fix is obvious. Stored
 * encrypted under `tokens`, the same slot the Google refresh token uses, so
 * the cron's "has credentials" query finds it. The whole window is pulled
 * before returning: the person who pasted a key should see a number, not a
 * promise about tomorrow's cron.
 */
export async function connectBing(_prev: BingConnectState, formData: FormData): Promise<BingConnectState> {
  const workspaceId = String(formData.get("workspace_id") ?? "");
  const apiKey = String(formData.get("apiKey") ?? "").trim();
  if (!workspaceId) return { ok: false, error: "Choose a workspace." };
  if (!apiKey) return { ok: false, error: "Paste the API key from Bing Webmaster Tools." };

  const { agencyId } = await requireAuth();
  const supabase = await createClient();

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id, domain")
    .eq("id", workspaceId)
    .eq("agency_id", agencyId)
    .maybeSingle();
  if (!workspace) return { ok: false, error: "That workspace is not in your account." };
  if (!workspace.domain) return { ok: false, error: "Set the workspace's domain first; Bing sites are matched by it." };

  let sites;
  try {
    sites = await listBingSites(apiKey);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Bing did not answer." };
  }
  const match = matchBingSite(sites, workspace.domain);
  if (!match) {
    const verified = sites.filter((s) => s.isVerified).map((s) => s.url);
    return {
      ok: false,
      error: verified.length
        ? `This key works, but its account has no verified site for ${workspace.domain}. It has: ${verified.slice(0, 5).join(", ")}. Add ${workspace.domain} in Bing Webmaster Tools, or import your Search Console sites there.`
        : `This key works, but its account has no verified sites yet. Add ${workspace.domain} in Bing Webmaster Tools and verify it, then connect again.`,
    };
  }

  const { data: row, error } = await supabase
    .from("workspace_integrations")
    .upsert(
      {
        workspace_id: workspace.id,
        integration_id: "bing",
        config: { type: "bing", bingSiteUrl: match.url },
        tokens: { encrypted: encrypt(JSON.stringify({ apiKey })) },
        connected_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,integration_id" },
    )
    .select("id, tokens, config")
    .single();
  if (error || !row) return { ok: false, error: error?.message ?? "Could not save the connection." };

  const result = await syncBingWorkspace(
    supabase,
    { id: row.id, tokens: row.tokens as { encrypted?: string }, config: row.config as { bingSiteUrl?: string }, workspace: { id: workspace.id, domain: workspace.domain } },
    60,
  );

  revalidatePath("/connect");
  revalidatePath("/dashboard");
  return {
    ok: true,
    siteUrl: match.url,
    rows: result.rows,
    from: result.from,
    // Connected is true either way; a failed first pull is worth saying, not
    // hiding behind a green pill.
    warning: result.error,
  };
}
