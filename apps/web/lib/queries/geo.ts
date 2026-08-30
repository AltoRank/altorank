import { createClient } from "@/lib/supabase/server";
import { summariseVisibility, type VisibilityResult, type AiEngine } from "@/lib/geo/ai-visibility";

export interface GeoPrompt {
  id: string;
  workspace_id: string;
  prompt: string;
  enabled: boolean;
  created_at: string;
}

export interface GeoResultRow {
  id: string;
  workspace_id: string;
  prompt: string;
  engine: AiEngine;
  model: string;
  mentioned: boolean;
  cited: boolean;
  citations: Array<{ title: string; url: string; domain: string }>;
  competitor_domains: string[];
  fan_out_queries: string[];
  cost_usd: number;
  error: string | null;
  checked_at: string;
}

export async function getGeoPrompts(workspaceId?: string): Promise<GeoPrompt[]> {
  const supabase = await createClient();
  let query = supabase.from("geo_prompts").select("*").order("created_at");
  if (workspaceId) query = query.eq("workspace_id", workspaceId);
  const { data } = await query;
  return (data ?? []) as GeoPrompt[];
}

/**
 * The most recent sweep only.
 *
 * A "sweep" is every probe sharing the newest measurement date, not the newest
 * N rows: mixing two runs would blend a mention rate across different prompt
 * sets and different weeks, which is the sort of number that looks precise and
 * means nothing.
 */
export async function getLatestGeoResults(workspaceId?: string): Promise<GeoResultRow[]> {
  const supabase = await createClient();
  let query = supabase
    .from("geo_results")
    .select("*")
    .order("checked_at", { ascending: false })
    .limit(200);
  if (workspaceId) query = query.eq("workspace_id", workspaceId);

  const { data } = await query;
  const rows = (data ?? []) as GeoResultRow[];
  if (!rows.length) return [];

  const newest = new Date(rows[0].checked_at).getTime();
  // Same run, allowing for the minutes a sweep takes to walk every engine.
  const WINDOW_MS = 60 * 60 * 1000;
  return rows.filter((r) => newest - new Date(r.checked_at).getTime() < WINDOW_MS);
}

/** Rolls the stored rows back through the same summariser the cron reports with. */
export function summariseRows(rows: GeoResultRow[]) {
  const results: VisibilityResult[] = rows.map((r) => ({
    prompt: r.prompt,
    engine: r.engine,
    model: r.model,
    answer: "",
    mentioned: r.mentioned,
    cited: r.cited,
    citations: r.citations ?? [],
    competitorDomains: r.competitor_domains ?? [],
    fanOutQueries: r.fan_out_queries ?? [],
    costUsd: Number(r.cost_usd) || 0,
    ...(r.error ? { error: r.error } : {}),
  }));
  return summariseVisibility(results);
}
