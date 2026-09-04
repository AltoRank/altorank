// ---------------------------------------------------------------------------
// Reads behind the Search Console blocks
// ---------------------------------------------------------------------------
//
// Thin on purpose: fetch the rows for one workspace, hand them to the pure
// functions in ./analysis. One row fetch feeds every block on the dashboard,
// so the page pays for the window once rather than once per card.
//
// Paginated because PostgREST caps a response at 1,000 rows and says nothing
// when it does. A site with 500 queries a day over 56 days is 28,000 rows;
// the old traffic query read the first thousand and charted them as the
// whole month.

import { createClient } from "@/lib/supabase/server";
import { inspectionFrom, type UrlInspection } from "@/lib/google/inspection";
import { WINDOW_DAYS, windows, type GscRow, type KnownPage } from "./analysis";

const PAGE = 1000;

type Page<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

async function fetchAll<T>(make: (from: number, to: number) => Page<T>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await make(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const batch = data ?? [];
    out.push(...batch);
    if (batch.length < PAGE) return out;
  }
}

/**
 * Every Search Console row for the two windows. Optional workspace for the
 * same reason its siblings are: a caller with no scope (operator views) sees
 * the account; every page passes one.
 */
export async function loadGscRows(workspaceId?: string, today: Date = new Date(), days = WINDOW_DAYS): Promise<GscRow[]> {
  const supabase = await createClient();
  const { since } = windows(today, days);
  return fetchAll<GscRow>((from, to) => {
    let q = supabase
      .from("analytics_metrics")
      .select("metric_date, clicks, impressions, avg_position, page_url, query, article_id")
      .eq("source", "gsc")
      .gte("metric_date", since)
      .order("metric_date", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);
    if (workspaceId) q = q.eq("workspace_id", workspaceId);
    return q;
  });
}

export type SyncHealth = {
  /** A Search Console row exists for this workspace. */
  connected: boolean;
  connectedAt: string | null;
  /** The property the sync resolved, once it has. */
  siteUrl: string | null;
  /** When the newest Search Console row was written. Null is "never". */
  lastSyncAt: string | null;
  /** The newest day Google has reported. */
  latestMetricDate: string | null;
};

export async function syncHealthFor(workspaceId: string): Promise<SyncHealth> {
  const supabase = await createClient();
  const [conn, newest, latestDay] = await Promise.all([
    supabase
      .from("workspace_integrations")
      .select("connected_at, config")
      .eq("workspace_id", workspaceId)
      .eq("integration_id", "gsc")
      .maybeSingle(),
    supabase
      .from("analytics_metrics")
      .select("created_at")
      .eq("workspace_id", workspaceId)
      .eq("source", "gsc")
      .order("created_at", { ascending: false })
      .limit(1),
    supabase
      .from("analytics_metrics")
      .select("metric_date")
      .eq("workspace_id", workspaceId)
      .eq("source", "gsc")
      .order("metric_date", { ascending: false })
      .limit(1),
  ]);
  const config = (conn.data?.config as { gscSiteUrl?: string } | null) ?? null;
  return {
    connected: Boolean(conn.data),
    connectedAt: (conn.data?.connected_at as string | null) ?? null,
    siteUrl: config?.gscSiteUrl ?? null,
    lastSyncAt: ((newest.data?.[0] as { created_at?: string } | undefined)?.created_at as string | undefined) ?? null,
    latestMetricDate: ((latestDay.data?.[0] as { metric_date?: string } | undefined)?.metric_date as string | undefined) ?? null,
  };
}

export type KnownPageRow = KnownPage & {
  articleId: string | null;
  title: string | null;
  inspection: UrlInspection | null;
};

/**
 * Every page we know this site has: live articles with a published URL, and
 * the pages the sitemap crawl found. Section indexes stay out - an index of
 * posts is not a page anyone asks Google to rank.
 */
export async function knownPagesFor(workspaceId: string): Promise<KnownPageRow[]> {
  const supabase = await createClient();
  const [articles, pages] = await Promise.all([
    supabase
      .from("articles")
      .select("id, title, published_url, indexing_status")
      .eq("workspace_id", workspaceId)
      .eq("status", "live")
      .not("published_url", "is", null),
    supabase
      .from("site_pages")
      .select("url, title, page_type")
      .eq("workspace_id", workspaceId),
  ]);
  if (articles.error) throw new Error(articles.error.message);
  const out: KnownPageRow[] = [];
  for (const a of (articles.data ?? []) as Array<{ id: string; title: string | null; published_url: string; indexing_status: unknown }>) {
    out.push({ url: a.published_url, articleId: a.id, title: a.title, inspection: inspectionFrom(a.indexing_status) });
  }
  for (const p of (pages.data ?? []) as Array<{ url: string; title: string | null; page_type: string | null }>) {
    if (p.page_type === "listing") continue;
    out.push({ url: p.url, articleId: null, title: p.title, inspection: null });
  }
  return out;
}
