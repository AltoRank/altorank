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
import {
  fetchGSCDailyTotals,
  fetchGSCPageMetrics,
  fetchGSCQueryMetrics,
  fetchGSCQueryPageMetrics,
  listGSCSites,
  matchGSCSite,
} from "@/lib/google/gsc";
import { articleIndex, gscRowsForDay } from "@/lib/gsc/rows";

export type SyncableIntegration = {
  id: string;
  tokens: { encrypted?: string } | null;
  config: { ga4PropertyId?: string; gscSiteUrl?: string } | null;
  workspace: { id: string; domain: string | null } | null;
};

export type SyncResult = { workspaceId: string; ga4: number; gsc: number; error?: string };

/**
 * The Search Console property this integration reads, resolved once and
 * stored on the integration's config.
 *
 * The account may own a domain property, a URL-prefix property, or none at
 * all, and guessing `sc-domain:<domain>` produced a 403 on every run for
 * altorank.co (2026-09-02). Shared by the nightly sync and the URL inspection
 * action, so both ask the same question and store the same answer.
 */
export async function resolveGscSiteUrl(
  supabase: SupabaseClient,
  integration: Pick<SyncableIntegration, "id" | "config">,
  domain: string,
  accessToken: string,
): Promise<string> {
  const stored = integration.config?.gscSiteUrl;
  if (stored) return stored;
  const sites = await listGSCSites(accessToken);
  const match = matchGSCSite(sites, domain);
  if (!match) {
    const owned = sites.map((s) => s.siteUrl).slice(0, 5).join(", ") || "none";
    throw new Error(
      `This Google account has no Search Console property for ${domain}. It can see: ${owned}. Add the property in Search Console, or reconnect with the account that owns it.`,
    );
  }
  await supabase
    .from("workspace_integrations")
    .update({ config: { ...(integration.config ?? {}), gscSiteUrl: match.siteUrl } })
    .eq("id", integration.id);
  return match.siteUrl;
}

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
      const siteUrl = await resolveGscSiteUrl(supabase, integration, ws.domain, accessToken);

      // Four reports, four row shapes, one delete. lib/gsc/analysis.ts says
      // which shape answers which question and why they are never summed
      // together; lib/gsc/rows.ts is the mapping from report to row.
      const { data: liveArticles } = await supabase
        .from("articles")
        .select("id, published_url")
        .eq("workspace_id", ws.id)
        .eq("status", "live")
        .not("published_url", "is", null);

      const [totals, queries, pages, queryPages] = await Promise.all([
        fetchGSCDailyTotals(accessToken, siteUrl, dateStr),
        fetchGSCQueryMetrics(accessToken, siteUrl, dateStr, dateStr),
        fetchGSCPageMetrics(accessToken, siteUrl, dateStr, dateStr),
        fetchGSCQueryPageMetrics(accessToken, siteUrl, dateStr, dateStr),
      ]);
      const rows = gscRowsForDay({
        workspaceId: ws.id,
        date: dateStr,
        totals,
        queries,
        pages,
        queryPages,
        articleIdByUrl: articleIndex((liveArticles ?? []) as Array<{ id: string; published_url: string | null }>),
      });
      await supabase.from("analytics_metrics").delete().eq("workspace_id", ws.id).eq("source", "gsc").eq("metric_date", dateStr);
      if (rows.length) { await supabase.from("analytics_metrics").insert(rows); gscCount = rows.length; }
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
