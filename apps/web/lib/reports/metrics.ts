import type { SupabaseClient } from "@supabase/supabase-js";

export interface ReportData {
  period: string;
  workspace: { name: string; domain: string };
  agency: { name: string; logo_url: string | null; accent_color: string | null; remove_branding: boolean };
  articlesPublished: number;
  totalKeywords: number;
  avgPosition: number;
  totalBacklinks: number;
  liveBacklinks: number;
  topArticles: Array<{
    title: string;
    keyword: string;
    position: number | null;
    seo_score: number;
  }>;
  keywordMovers: Array<{
    term: string;
    previousPosition: number;
    currentPosition: number;
    change: number;
  }>;
  ga4Summary: { pageviews: number; sessions: number } | null;
  gscSummary: { clicks: number; impressions: number; ctr: number } | null;
}

/**
 * Aggregate all metrics for a workspace over a given period.
 */
export async function aggregateReportData(
  supabase: SupabaseClient,
  workspaceId: string,
  startDate: string,
  endDate: string,
): Promise<ReportData> {
  // Fetch workspace + agency
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("name, domain, agency_id")
    .eq("id", workspaceId)
    .single();

  if (!workspace) throw new Error("Workspace not found");

  const { data: agency } = await supabase
    .from("agencies")
    .select("name, logo_url, accent_color, remove_branding")
    .eq("id", workspace.agency_id)
    .single();

  // Articles published in period
  const { count: articlesPublished } = await supabase
    .from("articles")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("status", "live")
    .gte("published_at", startDate)
    .lte("published_at", endDate);

  // Keywords
  const { data: keywords } = await supabase
    .from("keywords")
    .select("id, term")
    .eq("workspace_id", workspaceId);

  // Latest rankings for position average
  const keywordIds = (keywords ?? []).map((k) => k.id);
  let avgPosition = 0;
  const keywordMovers: ReportData["keywordMovers"] = [];

  if (keywordIds.length > 0) {
    const { data: rankings } = await supabase
      .from("keyword_rankings")
      .select("keyword_id, position, checked_at")
      .in("keyword_id", keywordIds)
      .gt("position", 0)
      .order("checked_at", { ascending: false });

    // Group by keyword, calculate movers
    const byKeyword = new Map<string, Array<{ position: number; checked_at: string }>>();
    for (const r of rankings ?? []) {
      const list = byKeyword.get(r.keyword_id) ?? [];
      list.push(r);
      byKeyword.set(r.keyword_id, list);
    }

    const positions: number[] = [];
    const termMap = new Map((keywords ?? []).map((k) => [k.id, k.term]));

    for (const [kwId, kwRankings] of byKeyword) {
      if (kwRankings.length > 0) positions.push(kwRankings[0].position);
      if (kwRankings.length >= 2) {
        const current = kwRankings[0].position;
        const previous = kwRankings[kwRankings.length - 1].position;
        const change = previous - current; // positive = improved
        keywordMovers.push({
          term: termMap.get(kwId) ?? "",
          previousPosition: previous,
          currentPosition: current,
          change,
        });
      }
    }

    avgPosition = positions.length > 0
      ? Math.round(positions.reduce((s, p) => s + p, 0) / positions.length * 10) / 10
      : 0;
  }

  // Sort movers by biggest improvement
  keywordMovers.sort((a, b) => b.change - a.change);

  // Backlinks
  const { data: backlinks } = await supabase
    .from("backlinks")
    .select("status")
    .eq("workspace_id", workspaceId);

  const totalBacklinks = backlinks?.length ?? 0;
  const liveBacklinks = (backlinks ?? []).filter((b) => b.status === "live").length;

  // Top articles by SEO score
  const { data: topArticles } = await supabase
    .from("articles")
    .select("title, keyword, position, seo_score")
    .eq("workspace_id", workspaceId)
    .eq("status", "live")
    .order("seo_score", { ascending: false })
    .limit(5);

  // Analytics
  const { data: ga4Data } = await supabase
    .from("analytics_metrics")
    .select("pageviews, sessions")
    .eq("workspace_id", workspaceId)
    .eq("source", "ga4")
    .gte("metric_date", startDate)
    .lte("metric_date", endDate);

  const ga4Summary = ga4Data?.length
    ? {
        pageviews: ga4Data.reduce((s, m) => s + (m.pageviews ?? 0), 0),
        sessions: ga4Data.reduce((s, m) => s + (m.sessions ?? 0), 0),
      }
    : null;

  const { data: gscData } = await supabase
    .from("analytics_metrics")
    .select("clicks, impressions, ctr")
    .eq("workspace_id", workspaceId)
    .eq("source", "gsc")
    .gte("metric_date", startDate)
    .lte("metric_date", endDate);

  const gscSummary = gscData?.length
    ? {
        clicks: gscData.reduce((s, m) => s + (m.clicks ?? 0), 0),
        impressions: gscData.reduce((s, m) => s + (m.impressions ?? 0), 0),
        ctr: gscData.reduce((s, m) => s + (m.ctr ?? 0), 0) / gscData.length,
      }
    : null;

  return {
    period: `${startDate} to ${endDate}`,
    workspace: { name: workspace.name, domain: workspace.domain },
    agency: {
      name: agency?.name ?? "",
      logo_url: agency?.logo_url ?? null,
      accent_color: agency?.accent_color ?? null,
      remove_branding: agency?.remove_branding ?? false,
    },
    articlesPublished: articlesPublished ?? 0,
    totalKeywords: keywords?.length ?? 0,
    avgPosition,
    totalBacklinks,
    liveBacklinks,
    topArticles: (topArticles ?? []).map((a) => ({
      title: a.title,
      keyword: a.keyword,
      position: a.position,
      seo_score: a.seo_score,
    })),
    keywordMovers: keywordMovers.slice(0, 10),
    ga4Summary,
    gscSummary,
  };
}
