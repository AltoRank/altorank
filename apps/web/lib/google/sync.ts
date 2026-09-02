// Analytics sync for one workspace integration, shared by the nightly cron
// and the moment of connection.
//
// Connecting Search Console used to store tokens and redirect to the
// integrations page with "Analytics will start flowing on the next scheduled
// sync", which meant 04:00 UTC the next day. Now the connection itself pulls
// the last week, and the person lands on the workspace with the numbers.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getValidAccessToken } from "@/lib/google/oauth";
import { fetchGA4Metrics } from "@/lib/google/ga4";
import { fetchGSCQueryMetrics, fetchGSCPageMetrics } from "@/lib/google/gsc";

export type SyncableIntegration = {
  id: string;
  tokens: { encrypted?: string } | null;
  config: { ga4PropertyId?: string } | null;
  workspace: { id: string; domain: string | null } | null;
};

export type SyncResult = { workspaceId: string; ga4: number; gsc: number; error?: string };

const norm = (u: string) => {
  try {
    const url = new URL(u);
    return (url.host + url.pathname).replace(/\/+$/, "").toLowerCase();
  } catch {
    return u.toLowerCase();
  }
};

/** Sync one day of GA4 and Search Console data for one integration. */
export async function syncWorkspaceAnalytics(
  supabase: SupabaseClient,
  integration: SyncableIntegration,
  dateStr: string,
): Promise<SyncResult> {
  const ws = integration.workspace;
  if (!ws) return { workspaceId: "", ga4: 0, gsc: 0, error: "no workspace" };
  const encrypted = integration.tokens?.encrypted;
  if (!encrypted) return { workspaceId: ws.id, ga4: 0, gsc: 0, error: "no tokens" };

  try {
    const accessToken = await getValidAccessToken(encrypted, async (newEncrypted) => {
      await supabase.from("workspace_integrations").update({ tokens: { encrypted: newEncrypted } }).eq("id", integration.id);
    });

    // Re-running a day must not double it: clear that day's rows for this
    // workspace and source before inserting. The cron never re-ran a day, but
    // the connect-time backfill overlaps with the next night's run.
    let ga4Count = 0;
    let gscCount = 0;

    if (integration.config?.ga4PropertyId) {
      const metrics = await fetchGA4Metrics(accessToken, integration.config.ga4PropertyId, dateStr, dateStr);
      const rows = metrics.map((m) => ({ workspace_id: ws.id, source: "ga4" as const, metric_date: dateStr, pageviews: m.pageviews, sessions: m.sessions, page_url: m.pageUrl }));
      await supabase.from("analytics_metrics").delete().eq("workspace_id", ws.id).eq("source", "ga4").eq("metric_date", dateStr);
      if (rows.length) { await supabase.from("analytics_metrics").insert(rows); ga4Count = rows.length; }
    }

    if (ws.domain) {
      const siteUrl = `sc-domain:${ws.domain.replace(/^www\./, "")}`;
      const queries = await fetchGSCQueryMetrics(accessToken, siteUrl, dateStr, dateStr);
      const rows = queries.map((q) => ({ workspace_id: ws.id, source: "gsc" as const, metric_date: dateStr, clicks: q.clicks, impressions: q.impressions, ctr: q.ctr, avg_position: q.position, query: q.query }));
      await supabase.from("analytics_metrics").delete().eq("workspace_id", ws.id).eq("source", "gsc").eq("metric_date", dateStr);
      if (rows.length) { await supabase.from("analytics_metrics").insert(rows); gscCount = rows.length; }

      const { data: liveArticles } = await supabase
        .from("articles")
        .select("id, published_url")
        .eq("workspace_id", ws.id)
        .eq("status", "live")
        .not("published_url", "is", null);
      if (liveArticles?.length) {
        const byPath = new Map(liveArticles.map((a) => [norm(a.published_url as string), a.id as string]));
        const pages = await fetchGSCPageMetrics(accessToken, siteUrl, dateStr, dateStr);
        const pageRows = pages
          .map((pg) => {
            const articleId = byPath.get(norm(pg.pageUrl));
            if (!articleId) return null;
            return { workspace_id: ws.id, article_id: articleId, source: "gsc" as const, metric_date: dateStr, clicks: pg.clicks, impressions: pg.impressions, ctr: pg.ctr, avg_position: pg.position, page_url: pg.pageUrl };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);
        if (pageRows.length) { await supabase.from("analytics_metrics").insert(pageRows); gscCount += pageRows.length; }
      }
    }

    return { workspaceId: ws.id, ga4: ga4Count, gsc: gscCount };
  } catch (err) {
    return { workspaceId: ws.id, ga4: 0, gsc: 0, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/** Yesterday back to `days` ago, one call set per day. Search Console lags
 *  about two days, so the newest day or two may be empty; that is Google. */
export async function backfillAnalytics(
  supabase: SupabaseClient,
  workspaceId: string,
  integrationId: string,
  days = 7,
): Promise<{ days: number; gsc: number; ga4: number; errors: string[] }> {
  const { data: integration } = await supabase
    .from("workspace_integrations")
    .select("*, workspace:workspaces(id, domain)")
    .eq("workspace_id", workspaceId)
    .eq("integration_id", integrationId)
    .maybeSingle();
  if (!integration) return { days: 0, gsc: 0, ga4: 0, errors: ["integration not found"] };

  const out = { days: 0, gsc: 0, ga4: 0, errors: [] as string[] };
  for (let i = 1; i <= days; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const r = await syncWorkspaceAnalytics(supabase, integration as SyncableIntegration, d.toISOString().slice(0, 10));
    out.days++;
    out.gsc += r.gsc;
    out.ga4 += r.ga4;
    if (r.error) out.errors.push(r.error);
  }
  return out;
}
