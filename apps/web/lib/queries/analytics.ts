import { createClient } from "@/lib/supabase/server";
import type { AnalyticsMetric } from "@/lib/types";

/**
 * Get aggregated analytics metrics for a workspace over a date range.
 */
export async function getAnalyticsMetrics(
  workspaceId: string,
  startDate: string,
  endDate: string,
): Promise<AnalyticsMetric[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("analytics_metrics")
    .select("*")
    .eq("workspace_id", workspaceId)
    .gte("metric_date", startDate)
    .lte("metric_date", endDate)
    .order("metric_date", { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as AnalyticsMetric[];
}

/**
 * Get analytics summary for a workspace (totals over period).
 */
export async function getAnalyticsSummary(
  workspaceId: string,
  startDate: string,
  endDate: string,
): Promise<{
  totalPageviews: number;
  totalSessions: number;
  totalClicks: number;
  totalImpressions: number;
  avgCtr: number;
  avgPosition: number;
}> {
  const metrics = await getAnalyticsMetrics(workspaceId, startDate, endDate);

  const ga4 = metrics.filter((m) => m.source === "ga4");
  const gsc = metrics.filter((m) => m.source === "gsc");

  const totalPageviews = ga4.reduce((s, m) => s + m.pageviews, 0);
  const totalSessions = ga4.reduce((s, m) => s + m.sessions, 0);
  const totalClicks = gsc.reduce((s, m) => s + m.clicks, 0);
  const totalImpressions = gsc.reduce((s, m) => s + m.impressions, 0);
  const avgCtr = gsc.length > 0
    ? gsc.reduce((s, m) => s + m.ctr, 0) / gsc.length
    : 0;
  const avgPosition = gsc.length > 0
    ? gsc.reduce((s, m) => s + (m.avg_position ?? 0), 0) / gsc.length
    : 0;

  return {
    totalPageviews,
    totalSessions,
    totalClicks,
    totalImpressions,
    avgCtr: Math.round(avgCtr * 10000) / 10000,
    avgPosition: Math.round(avgPosition * 100) / 100,
  };
}
