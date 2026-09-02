import { createClient } from "@/lib/supabase/server";

export interface TrafficSeries {
  /** Daily clicks for the current window, oldest first. */
  current: number[];
  /** The window immediately before it, same length, for comparison. */
  previous: number[];
  currentTotal: number;
  previousTotal: number;
  /** Percent change, or null when the previous window had no traffic to compare against. */
  changePct: number | null;
  /** False when no analytics have ever been synced. */
  hasData: boolean;
  /**
   * False when the window was synced and nobody clicked.
   *
   * Distinct from `hasData` on purpose: "we have not measured this" and "we
   * measured it and it is zero" are different statements, and only the second
   * one earns a number. A new site with impressions and no clicks is the
   * normal case, not an error, and a flat line at zero says nothing about
   * which of the two it is.
   */
  hasClicks: boolean;
  /** Impressions over the window. A site can have thousands with no clicks,
   *  and a flat line at zero should say which of those two it is. */
  impressions: number;
  days: number;
}

const DAYS = 30;

const EMPTY: TrafficSeries = {
  current: [],
  previous: [],
  currentTotal: 0,
  previousTotal: 0,
  changePct: null,
  hasData: false,
  hasClicks: false,
  impressions: 0,
  days: DAYS,
};

/**
 * Real organic clicks from Search Console, by day.
 *
 * This exists because the dashboard chart was a hardcoded array of thirty
 * numbers rising from 14 to 80, with a fabricated "previous period" line under
 * it. Every account saw the same invented growth curve, directly beneath a stat
 * that honestly read "Organic traffic — / Connect analytics".
 *
 * Returns `hasData: false` rather than zeroes when nothing has been synced. A
 * flat line at zero is itself a claim, and "we have no data" and "you have no
 * traffic" are very different things to tell a client.
 */
export async function getTrafficSeries(workspaceId?: string): Promise<TrafficSeries> {
  const supabase = await createClient();

  const start = new Date(Date.now() - DAYS * 2 * 86_400_000);
  const startDate = start.toISOString().slice(0, 10);

  let query = supabase
    .from("analytics_metrics")
    .select("metric_date, clicks, impressions")
    .eq("source", "gsc")
    .gte("metric_date", startDate)
    .order("metric_date", { ascending: true });

  if (workspaceId) query = query.eq("workspace_id", workspaceId);

  const { data, error } = await query;
  if (error || !data?.length) return EMPTY;

  // Sum per day: GSC rows arrive split by query and page, so several rows share
  // one date and the daily total is their sum.
  const byDay = new Map<string, number>();
  for (const row of data as Array<{ metric_date: string; clicks: number | null }>) {
    byDay.set(row.metric_date, (byDay.get(row.metric_date) ?? 0) + (row.clicks ?? 0));
  }

  const series: number[] = [];
  for (let i = DAYS * 2 - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    series.push(byDay.get(d) ?? 0);
  }

  // Impressions over the whole window, so an all-zero click series can still
  // say whether Google is showing the pages at all.
  const impressions = (data as Array<{ impressions: number | null }>).reduce(
    (sum, r) => sum + (r.impressions ?? 0),
    0,
  );

  const previous = series.slice(0, DAYS);
  const current = series.slice(DAYS);
  const currentTotal = current.reduce((a, b) => a + b, 0);
  const previousTotal = previous.reduce((a, b) => a + b, 0);

  return {
    current,
    previous,
    currentTotal,
    previousTotal,
    // No baseline means no percentage. Reporting "+100%" against zero is a
    // number that sounds like growth and describes nothing.
    changePct: previousTotal > 0
      ? Math.round(((currentTotal - previousTotal) / previousTotal) * 1000) / 10
      : null,
    hasData: true,
    hasClicks: currentTotal > 0 || previousTotal > 0,
    impressions,
    days: DAYS,
  };
}
