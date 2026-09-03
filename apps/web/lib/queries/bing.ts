import { createClient } from "@/lib/supabase/server";

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
  let rows = supabase.from("analytics_metrics").select("clicks, impressions").eq("source", "bing").gte("metric_date", since);
  if (workspaceId) rows = rows.eq("workspace_id", workspaceId);

  const [{ count }, { data }] = await Promise.all([conn, rows]);
  const list = (data ?? []) as Array<{ clicks: number | null; impressions: number | null }>;
  return {
    connected: (count ?? 0) > 0,
    hasData: list.length > 0,
    clicks: list.reduce((s, r) => s + (r.clicks ?? 0), 0),
    impressions: list.reduce((s, r) => s + (r.impressions ?? 0), 0),
    days: DAYS,
  };
}
