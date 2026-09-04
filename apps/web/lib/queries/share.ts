import { createClient } from "@/lib/supabase/server";
import type { ShareCardFacts } from "@/lib/share/card";

const CLICK_DAYS = 28;

/**
 * The measured facts behind the share card, for one workspace.
 *
 * Every read names the workspace. Clicks are null, not zero, when Search
 * Console is not connected or has synced nothing for the window; a connected
 * account that measured zero clicks gets a real zero.
 */
export async function getShareCardFacts(workspaceId: string): Promise<ShareCardFacts | null> {
  const supabase = await createClient();
  const today = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - CLICK_DAYS * 86_400_000).toISOString().slice(0, 10);

  const [{ data: ws }, { count: published }, { count: planned }, { count: gscCount }, { data: clickRows }] =
    await Promise.all([
      supabase
        .from("workspaces")
        .select("id, domain, dr, agency_id, agencies(remove_branding)")
        .eq("id", workspaceId)
        .maybeSingle(),
      supabase
        .from("articles")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("status", "live"),
      supabase
        .from("calendar_entries")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .in("status", ["queue", "scheduled"])
        .gte("scheduled_date", today),
      supabase
        .from("workspace_integrations")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("integration_id", "gsc"),
      supabase
        .from("analytics_metrics")
        .select("clicks")
        .eq("workspace_id", workspaceId)
        .eq("source", "gsc")
        .gte("metric_date", since),
    ]);
  if (!ws) return null;

  const gscConnected = (gscCount ?? 0) > 0;
  const rows = (clickRows ?? []) as Array<{ clicks: number | null }>;
  const agency = ws.agencies as unknown as { remove_branding: boolean | null } | null;

  return {
    domain: ws.domain ?? "",
    dr: typeof ws.dr === "number" ? ws.dr : null,
    published: published ?? 0,
    planned: planned ?? 0,
    gscConnected,
    clicks28d: gscConnected && rows.length > 0 ? rows.reduce((s, r) => s + (r.clicks ?? 0), 0) : null,
    removeBranding: Boolean(agency?.remove_branding),
  };
}
