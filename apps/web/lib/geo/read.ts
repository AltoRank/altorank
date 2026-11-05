import type { SupabaseClient } from "@supabase/supabase-js";
import { summariseVisibility, type VisibilityResult, type AiEngine } from "./ai-visibility";
import type { RunSettings } from "./runs";

// Reading a sweep back, with whichever client the caller holds: the dashboard's
// cookie client (RLS scopes it to the member's sites) or the report builder's.

export interface GeoResultRow {
  id: string;
  workspace_id: string;
  run_id: string | null;
  sample: number | null;
  prompt: string;
  engine: AiEngine;
  surface: "app" | "api";
  status: "pending" | "ok" | "failed";
  model: string;
  answer: string | null;
  mentioned: boolean;
  cited: boolean;
  citations: Array<{ title: string; url: string; domain: string }>;
  competitor_domains: string[];
  brands: string[];
  fan_out_queries: string[];
  cost_usd: number;
  error: string | null;
  checked_at: string;
}

export interface GeoRun {
  id: string;
  workspace_id: string;
  status: "running" | "complete" | "partial";
  planned: number;
  captured: number;
  failed: number;
  settings: RunSettings;
  cost_usd: number;
  started_at: string;
  finished_at: string | null;
}

const PAGE = 1000;

/** Every row of one run, paged: a run is hundreds of answers, past any one-call cap. */
export async function readRunRows(db: SupabaseClient, workspaceId: string, runId: string): Promise<GeoResultRow[]> {
  const out: GeoResultRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data } = await db
      .from("geo_results")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("run_id", runId)
      .order("id")
      .range(from, from + PAGE - 1);
    out.push(...((data ?? []) as GeoResultRow[]));
    if (!data || data.length < PAGE) return out;
  }
}

/**
 * The newest finished sweep of one site that captured anything, or else the
 * newest sweep at all (one still collecting, or one that came back empty).
 *
 * A sweep that captured nothing - a DataForSEO outage, a plan that lapsed
 * mid-week - is not a reading, and taking it as the latest would replace last
 * week's number with "not measured" on the page and in the client report.
 *
 * One site, always. The earlier version took an optional workspace and, given
 * none, blended every site in the account into one mention rate measured
 * against one brand. A sweep is a run row now, not "every probe within an hour
 * of the newest", so two sweeps can no longer be mixed by timing.
 */
export async function latestGeoRun(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<{ run: GeoRun; rows: GeoResultRow[] } | null> {
  const { data: runs } = await supabase
    .from("geo_runs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("started_at", { ascending: false })
    .limit(5);
  const list = (runs ?? []) as GeoRun[];
  const run = pickLatestRun(list);
  if (!run) return null;
  return { run, rows: await readRunRows(supabase, workspaceId, run.id) };
}

/** Which of a site's recent runs (newest first) to show. */
export function pickLatestRun(runs: GeoRun[]): GeoRun | undefined {
  return runs.find((r) => r.status !== "running" && r.captured > 0) ?? runs[0];
}

/** Rolls the stored rows back through the same summariser the cron reports with. Pending rows are not answers yet. */
export function summariseRows(rows: GeoResultRow[]) {
  const results: VisibilityResult[] = rows
    .filter((r) => r.status !== "pending")
    .map((r) => ({
      prompt: r.prompt,
      engine: r.engine,
      model: r.model,
      answer: r.answer ?? "",
      mentioned: r.mentioned,
      cited: r.cited,
      citations: r.citations ?? [],
      competitorDomains: r.competitor_domains ?? [],
      brands: r.brands ?? [],
      fanOutQueries: r.fan_out_queries ?? [],
      costUsd: Number(r.cost_usd) || 0,
      ...(r.status === "failed" || r.error ? { error: r.error ?? "failed" } : {}),
    }));
  return summariseVisibility(results);
}

/**
 * The AI-visibility block of the client report, or null when there is nothing
 * to report: never measured, or measured and every sample failed. "Never
 * measured" and "measured, found nothing" look the same once a percentage is
 * rendered, and only one of them is a finding a client should be shown.
 * Rates are 0-1 here, as the report renders them.
 */
export function geoReportSummary(latest: { run: GeoRun; rows: GeoResultRow[] } | null): {
  promptsTracked: number;
  engines: string[];
  mentionRate: number;
  citationRate: number;
  topCompetitors: Array<{ domain: string; citations: number }>;
  checkedAt: string;
} | null {
  const answered = (latest?.rows ?? []).filter((r) => r.status === "ok" && !r.error);
  if (!latest || !answered.length) return null;
  const s = summariseRows(latest.rows);
  return {
    promptsTracked: new Set(answered.map((r) => r.prompt)).size,
    engines: [...new Set(answered.map((r) => r.engine as string))].sort(),
    mentionRate: s.mentionRate / 100,
    citationRate: s.citationRate / 100,
    topCompetitors: s.topCompetitors.slice(0, 5).map(({ domain, citations }) => ({ domain, citations })),
    checkedAt: latest.run.finished_at ?? latest.run.started_at,
  };
}
