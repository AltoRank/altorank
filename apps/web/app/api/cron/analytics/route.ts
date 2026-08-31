import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getValidAccessToken } from "@/lib/google/oauth";
import { fetchGA4Metrics } from "@/lib/google/ga4";
import { fetchGSCQueryMetrics, fetchGSCPageMetrics } from "@/lib/google/gsc";

/**
 * Daily cron: sync GA4 + GSC metrics for all connected workspaces.
 */
export async function GET(request: Request) {
  const cronSecret = request.headers.get("x-cron-secret");
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  /**
 * Cron requests carry no cookies, so the cookie-bound client authenticates as
 * nobody and RLS answers every query with an empty set. That is not an error,
 * so this route reported `success` with a zero count and had never processed a
 * single row. A cron has no user by definition: it must hold the service role.
 */
  const supabase = createServiceClient();

  // Find all workspace_integrations with Google tokens
  const { data: integrations, error: integrationsError } = await supabase
    .from("workspace_integrations")
    .select("*, workspace:workspaces(id, domain)")
    .not("tokens", "is", null);

  // A query that failed and a workspace list that is genuinely empty both arrive
  // here as a falsy `data`. Reporting the first as `synced: 0` told the caller
  // the sync had run and found nothing to do, so an unreachable database looked
  // exactly like a quiet day for as long as it stayed down.
  if (integrationsError) {
    return NextResponse.json({ error: integrationsError.message }, { status: 500 });
  }

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

        /**
         * Per-article attribution, the half that was never wired.
         *
         * `fetchGSCPageMetrics` and the `article_id` column have existed since
         * migration 006, and nothing ever connected them: the product wrote
         * articles and then could not say what any of them earned. Page rows
         * are matched to articles by published_url (path-normalised, because
         * GSC reports canonical URLs and published_url sometimes carries a
         * trailing slash or query the site added).
         *
         * This is the loop Outrank sells as "watches how your published
         * content performs" - the difference is ours attributes to the
         * article row the reviewer approved.
         */
        const { data: liveArticles } = await supabase
          .from("articles")
          .select("id, published_url")
          .eq("workspace_id", ws.id)
          .eq("status", "live")
          .not("published_url", "is", null);

        if (liveArticles && liveArticles.length > 0) {
          const norm = (u: string) => {
            try {
              const url = new URL(u);
              return (url.host + url.pathname).replace(/\/+$/, "").toLowerCase();
            } catch {
              return u.toLowerCase();
            }
          };
          const byPath = new Map(
            liveArticles.map((a) => [norm(a.published_url as string), a.id]),
          );

          const pages = await fetchGSCPageMetrics(accessToken, siteUrl, dateStr, dateStr);
          const pageRows = pages
            .map((pg) => {
              const articleId = byPath.get(norm(pg.pageUrl));
              if (!articleId) return null;
              return {
                workspace_id: ws.id,
                article_id: articleId,
                source: "gsc" as const,
                metric_date: dateStr,
                clicks: pg.clicks,
                impressions: pg.impressions,
                ctr: pg.ctr,
                avg_position: pg.position,
                page_url: pg.pageUrl,
              };
            })
            .filter(Boolean);

          if (pageRows.length > 0) {
            await supabase.from("analytics_metrics").insert(pageRows);
            gscCount += pageRows.length;
          }
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
