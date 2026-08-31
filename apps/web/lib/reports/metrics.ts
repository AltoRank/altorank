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
  /**
   * AI visibility from the most recent GEO sweep, or null when this workspace
   * has never been measured.
   *
   * The cron has been writing `geo_results` and the dashboard has been reading
   * them, but the client report — the one artifact an agency actually hands to
   * the person paying for GEO work — showed none of it. Measuring something and
   * then omitting it from the invoice-adjacent document is the same class of
   * problem as not measuring it.
   *
   * Null rather than zeroes when unmeasured, per the house rule: a workspace
   * nobody probed is not a workspace with zero citations.
   */
  geoSummary: {
    /** Distinct buyer questions asked this run. */
    promptsTracked: number;
    /** Engines the sweep covered, e.g. ChatGPT, Perplexity. */
    engines: string[];
    /** Share of answers naming the brand at all, 0-1. */
    mentionRate: number;
    /** Share of answers linking the brand's own domain, 0-1. */
    citationRate: number;
    /** Rival domains cited most often on the same questions. */
    topCompetitors: Array<{ domain: string; citations: number }>;
    checkedAt: string;
  } | null;
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

  // --- AI visibility -------------------------------------------------------
  // Scoped to the latest sweep rather than the report period: a GEO run is a
  // snapshot of what the engines answer today, so averaging several sweeps
  // across a month would blur the number the client is being shown. The window
  // matches getLatestGeoResults, which the dashboard already uses, so the report
  // and the screen agree.
  const { data: geoRows } = await supabase
    .from("geo_results")
    .select("prompt, engine, mentioned, cited, competitor_domains, checked_at, error")
    .eq("workspace_id", workspaceId)
    .order("checked_at", { ascending: false })
    .limit(200);

  let geoSummary: ReportData["geoSummary"] = null;
  if (geoRows?.length) {
    const newest = new Date(geoRows[0].checked_at as string).getTime();
    const SWEEP_WINDOW_MS = 60 * 60 * 1000;
    const run = geoRows.filter(
      (r) =>
        !r.error &&
        newest - new Date(r.checked_at as string).getTime() < SWEEP_WINDOW_MS,
    );

    // Every probe in the run errored: measured, but nothing to report. Left null
    // so the report says "not measured" instead of "cited in 0% of answers",
    // which would read as a finding rather than an absence.
    if (run.length) {
      const counts = new Map<string, number>();
      for (const r of run) {
        for (const domain of (r.competitor_domains as string[] | null) ?? []) {
          counts.set(domain, (counts.get(domain) ?? 0) + 1);
        }
      }

      geoSummary = {
        promptsTracked: new Set(run.map((r) => r.prompt as string)).size,
        engines: [...new Set(run.map((r) => r.engine as string))].sort(),
        mentionRate: run.filter((r) => r.mentioned).length / run.length,
        citationRate: run.filter((r) => r.cited).length / run.length,
        topCompetitors: [...counts.entries()]
          .map(([domain, citations]) => ({ domain, citations }))
          .sort((a, b) => b.citations - a.citations)
          .slice(0, 5),
        checkedAt: geoRows[0].checked_at as string,
      };
    }
  }

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
    geoSummary,
  };
}
