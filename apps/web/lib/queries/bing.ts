import { createClient } from "@/lib/supabase/server";
import { readAllPages } from "@/lib/supabase/read-all";

export type BingSummary = {
  /** A Bing key is stored for the workspace(s) in scope. */
  connected: boolean;
  /** Rows exist in the window. False is "not measured", not zero. */
  hasData: boolean;
  clicks: number;
  impressions: number;
  days: number;
};

const DAYS = 30;

/**
 * Bing clicks and impressions over the last 30 days, kept apart from the
 * Google series on purpose. Two engines summed into one line would be a number
 * that describes neither, and the dashboard's chart is Google's.
 */
export async function getBingSummary(workspaceId?: string): Promise<BingSummary> {
  const supabase = await createClient();
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10);

  let conn = supabase.from("workspace_integrations").select("id", { count: "exact", head: true }).eq("integration_id", "bing");
  if (workspaceId) conn = conn.eq("workspace_id", workspaceId);
  // One row per site per day, so the all-sites view of an account with more
  // than 33 Bing-connected sites is past PostgREST's 1,000-row cap in 30 days.
  // Paged, like every summed read of this table (lib/supabase/read-all.ts).
  // The workspace filter goes on after the range because the builder allows
  // it, and so the source pin stays in the one chain the read guard checks.
  const rows = readAllPages<{ clicks: number | null; impressions: number | null }>("Bing read", (from, to, count) => {
    const page = supabase
      .from("analytics_metrics")
      .select("clicks, impressions", { count })
      .eq("source", "bing")
      .gte("metric_date", since)
      .order("metric_date", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);
    return workspaceId ? page.eq("workspace_id", workspaceId) : page;
  }).catch((err: unknown) => {
    // A side line on the dashboard: a failed read shows as "no Bing data",
    // which is what an error here always looked like, rather than taking the
    // whole page down with it. Logged, so it is not also invisible.
    console.error(`[bing] summary read failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  });

  const [{ count }, list] = await Promise.all([conn, rows]);
  return {
    connected: (count ?? 0) > 0,
    hasData: list.length > 0,
    clicks: list.reduce((s, r) => s + (r.clicks ?? 0), 0),
    impressions: list.reduce((s, r) => s + (r.impressions ?? 0), 0),
    days: DAYS,
  };
}
