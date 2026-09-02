import { createClient } from "@/lib/supabase/server";

export type MetricPoint = {
  measured_on: string;
  authority: number | null;
  traffic: number | null;
  referring_domains: number | null;
  ranking_keywords: number | null;
  readiness: number | null;
};

/**
 * The workspace's own history, oldest first, for the small charts on its page.
 * Ninety days is what the analysis can have produced since this table existed;
 * a longer window would draw a line that mostly is not there.
 */
export async function getWorkspaceMetrics(workspaceId: string, days = 90): Promise<MetricPoint[]> {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("workspace_metrics")
    .select("measured_on, authority, traffic, referring_domains, ranking_keywords, readiness")
    .eq("workspace_id", workspaceId)
    .gte("measured_on", since.toISOString().slice(0, 10))
    .order("measured_on", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as MetricPoint[];
}
