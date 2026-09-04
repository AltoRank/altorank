// ---------------------------------------------------------------------------
// One day of Search Console, as `analytics_metrics` rows
// ---------------------------------------------------------------------------
//
// The sync fetches four reports for one day and stores each in its own row
// shape (see lib/gsc/analysis.ts for the shapes and why they never sum). This
// is the mapping from report to row, pulled out of the sync so the contract -
// which columns are null for which shape - is a thing a test can hold still.

import type { GSCPageMetrics, GSCQueryMetrics, GSCQueryPageMetrics, GSCTotals } from "@/lib/google/gsc";
import { normalizeUrl } from "./analysis";

export type AnalyticsInsert = {
  workspace_id: string;
  article_id: string | null;
  source: "gsc";
  metric_date: string;
  clicks: number;
  impressions: number;
  ctr: number;
  avg_position: number | null;
  page_url: string | null;
  query: string | null;
};

export type DayReports = {
  workspaceId: string;
  date: string;
  /** The property's total for the day; null when Google returned no row. */
  totals: GSCTotals | null;
  queries: GSCQueryMetrics[];
  pages: GSCPageMetrics[];
  queryPages: GSCQueryPageMetrics[];
  /** Live articles by normalised published URL, so a page row can name its article. */
  articleIdByUrl: Map<string, string>;
};

/** Live articles keyed the same way page URLs are, so the two meet. */
export function articleIndex(articles: Array<{ id: string; published_url: string | null }>): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of articles) if (a.published_url) out.set(normalizeUrl(a.published_url), a.id);
  return out;
}

export function gscRowsForDay(day: DayReports): AnalyticsInsert[] {
  const base = { workspace_id: day.workspaceId, source: "gsc" as const, metric_date: day.date };
  const rows: AnalyticsInsert[] = [];

  if (day.totals) {
    rows.push({ ...base, article_id: null, clicks: day.totals.clicks, impressions: day.totals.impressions, ctr: day.totals.ctr, avg_position: day.totals.position, page_url: null, query: null });
  }
  for (const q of day.queries) {
    rows.push({ ...base, article_id: null, clicks: q.clicks, impressions: q.impressions, ctr: q.ctr, avg_position: q.position, page_url: null, query: q.query });
  }
  // Every page, ours or not: the top-pages block is about the site, and a
  // page we did not write still competes with the ones we did.
  for (const p of day.pages) {
    rows.push({ ...base, article_id: day.articleIdByUrl.get(normalizeUrl(p.pageUrl)) ?? null, clicks: p.clicks, impressions: p.impressions, ctr: p.ctr, avg_position: p.position, page_url: p.pageUrl, query: null });
  }
  for (const qp of day.queryPages) {
    rows.push({ ...base, article_id: day.articleIdByUrl.get(normalizeUrl(qp.pageUrl)) ?? null, clicks: qp.clicks, impressions: qp.impressions, ctr: qp.ctr, avg_position: qp.position, page_url: qp.pageUrl, query: qp.query });
  }
  return rows;
}
