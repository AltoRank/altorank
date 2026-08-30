import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getValidAccessToken } from "@/lib/google/oauth";
import { fetchGA4Metrics } from "@/lib/google/ga4";
import { fetchGSCQueryMetrics } from "@/lib/google/gsc";

/**
 * Daily cron: sync GA4 + GSC metrics for all connected workspaces.
 */
export async function GET(request: Request) {
  const cronSecret = request.headers.get("x-cron-secret");
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = await createClient();

  // Find all workspace_integrations with Google tokens
  const { data: integrations } = await supabase
    .from("workspace_integrations")
    .select("*, workspace:workspaces(id, domain)")
    .not("tokens", "is", null);

  if (!integrations?.length) {
    return NextResponse.json({ success: true, synced: 0 });
  }

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().split("T")[0];

  const results: Array<{ workspaceId: string; ga4: number; gsc: number; error?: string }> = [];

  for (const integration of integrations) {
    const ws = integration.workspace as { id: string; domain: string } | null;
    if (!ws) continue;

    const tokens = integration.tokens as { encrypted?: string } | null;
    if (!tokens?.encrypted) continue;

    try {
      const accessToken = await getValidAccessToken(
        tokens.encrypted,
        async (newEncrypted) => {
          await supabase
            .from("workspace_integrations")
            .update({ tokens: { encrypted: newEncrypted } })
            .eq("id", integration.id);
        },
      );

      const config = integration.config as { ga4PropertyId?: string } | null;
      let ga4Count = 0;
      let gscCount = 0;

      // Sync GA4 if property ID configured
      if (config?.ga4PropertyId) {
        const metrics = await fetchGA4Metrics(
          accessToken,
          config.ga4PropertyId,
          dateStr,
          dateStr,
        );

        const rows = metrics.map((m) => ({
          workspace_id: ws.id,
          source: "ga4" as const,
          metric_date: dateStr,
          pageviews: m.pageviews,
          sessions: m.sessions,
          page_url: m.pageUrl,
        }));

        if (rows.length > 0) {
          await supabase.from("analytics_metrics").insert(rows);
          ga4Count = rows.length;
        }
      }

      // Sync GSC
      if (ws.domain) {
        const siteUrl = `sc-domain:${ws.domain}`;
        const queries = await fetchGSCQueryMetrics(
          accessToken,
          siteUrl,
          dateStr,
          dateStr,
        );

        const rows = queries.map((q) => ({
          workspace_id: ws.id,
          source: "gsc" as const,
          metric_date: dateStr,
          clicks: q.clicks,
          impressions: q.impressions,
          ctr: q.ctr,
          avg_position: q.position,
          query: q.query,
        }));

        if (rows.length > 0) {
          await supabase.from("analytics_metrics").insert(rows);
          gscCount = rows.length;
        }
      }

      results.push({ workspaceId: ws.id, ga4: ga4Count, gsc: gscCount });
    } catch (err) {
      results.push({
        workspaceId: ws.id,
        ga4: 0,
        gsc: 0,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  return NextResponse.json({ success: true, synced: results.length, results });
}
