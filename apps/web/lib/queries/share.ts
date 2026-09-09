import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import type { ShareCardFacts } from "@/lib/share/card";
import { resolveShareToken } from "@/lib/share/token";

const CLICK_DAYS = 28;

/**
 * The measured facts behind the share card, for one workspace, through the
 * signed-in user's client: RLS decides whether the id is theirs.
 */
export async function getShareCardFacts(workspaceId: string): Promise<ShareCardFacts | null> {
  return shareCardFactsWith(await createClient(), workspaceId);
}

/**
 * The same facts for a public share link. The service role reads them, so
 * the token is the whole credential: anything that does not resolve is null,
 * and the caller answers 404 with nothing else said.
 */
export async function getShareCardFactsByToken(token: unknown): Promise<ShareCardFacts | null> {
  const supabase = createServiceClient();
  const workspaceId = await resolveShareToken(supabase, token);
  if (!workspaceId) return null;
  return shareCardFactsWith(supabase, workspaceId);
}

/**
 * Every read names the workspace. Clicks are null, not zero, when Search
 * Console is not connected or has synced nothing for the window; a connected
 * account that measured zero clicks gets a real zero.
 */
export async function shareCardFactsWith(supabase: SupabaseClient, workspaceId: string): Promise<ShareCardFacts | null> {
  const today = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - CLICK_DAYS * 86_400_000).toISOString().slice(0, 10);

  const [{ data: ws }, { count: published }, { count: planned }, { count: gscCount }, { data: clickRows }] =
    await Promise.all([
      supabase
        .from("workspaces")
        .select("id, domain, dr, account_id, accounts(remove_branding)")
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
        // Property totals only. The sync writes four row shapes per day -
        // totals, per query, per page, and per (query, page) - and summing
        // them counts the same click up to four times (lib/gsc/analysis.ts).
        // This number is printed on a public share card and burned into its
        // OG image as "Search clicks, 28 days", which is the worst place in
        // the product to be four times too high: it is the figure an account
        // puts in front of its own client.
        .is("query", null)
        .is("page_url", null)
        .gte("metric_date", since),
    ]);
  if (!ws) return null;

  const gscConnected = (gscCount ?? 0) > 0;
  const rows = (clickRows ?? []) as Array<{ clicks: number | null }>;
  const account = ws.accounts as unknown as { remove_branding: boolean | null } | null;

  return {
    domain: ws.domain ?? "",
    // 001 gave `dr` a default of 0, so a row nobody measured reads 0 and a row
    // measured at 0 reads the same. The card cannot tell them apart, and a
    // "0" from a column default is exactly the fabricated figure this card
    // exists to avoid, so only a positive rating counts as measured.
    dr: typeof ws.dr === "number" && ws.dr > 0 ? ws.dr : null,
    published: published ?? 0,
    planned: planned ?? 0,
    gscConnected,
    clicks28d: gscConnected && rows.length > 0 ? rows.reduce((s, r) => s + (r.clicks ?? 0), 0) : null,
    removeBranding: Boolean(account?.remove_branding),
  };
}
