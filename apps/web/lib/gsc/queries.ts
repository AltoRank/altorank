// ---------------------------------------------------------------------------
// Reads behind the Search Console blocks
// ---------------------------------------------------------------------------
//
// Thin on purpose: fetch the rows for one workspace, hand them to the pure
// functions in ./analysis. One read of every shape feeds every block on the
// dashboard, so the page pays for the window once rather than once per card.
//
// The reading itself is lib/gsc/read.ts, the only place a Search Console row
// is read from: it partitions by shape and pages past PostgREST's 1,000-row
// cap. A site with 500 queries a day over 56 days is 28,000 rows; the old
// traffic query read the first thousand and charted them as the whole month.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { inspectionFrom, type UrlInspection } from "@/lib/google/inspection";
import { ANCHOR_MAX_LAG_DAYS, isoDaysAgo, ROW_SHAPES, WINDOW_DAYS, type GscCoverage, type GscShapes, type KnownPage } from "./analysis";
import { earliestGscDate, lastGscWriteAt, latestGscDate, readGsc, type ReadRow } from "./read";

/** What the dashboard blocks read: every shape, with the columns the analysis uses. */
export type DashboardGscRows = GscShapes<ReadRow<"clicks" | "impressions" | "avg_position" | "article_id" | "workspace_id">>;

/**
 * Every Search Console row for the two windows, by shape. Optional workspace
 * for the same reason its siblings are: a caller with no scope (operator
 * views) sees the account; every page passes one.
 */
export async function loadGscRows(workspaceId?: string, today: Date = new Date(), days = WINDOW_DAYS): Promise<DashboardGscRows> {
  return loadGscRowsFrom(await createClient(), workspaceId, today, days);
}

/**
 * The same read on a client the caller already holds. The agent API passes
 * its service-role client here, which is why `workspaceId` is not optional on
 * this variant: with no RLS behind the query, an unscoped read would return
 * every account's rows, not just this one's.
 */
export async function loadGscRowsFrom(
  supabase: SupabaseClient,
  workspaceId: string | undefined,
  today: Date = new Date(),
  days = WINDOW_DAYS,
): Promise<DashboardGscRows> {
  // A week further back than the two windows: the windows end on the newest
  // synced day (analysis.ts `windowAnchor`), which can be up to that many
  // days before `today`, and a caller may only learn it from these rows.
  const since = isoDaysAgo(today, days * 2 + ANCHOR_MAX_LAG_DAYS);
  return readGsc(supabase, {
    workspaceId: workspaceId ?? null,
    shapes: ROW_SHAPES,
    since,
    // workspace_id: the all-sites view tells each site's history apart (`rowsCoverage`).
    columns: ["clicks", "impressions", "avg_position", "article_id", "workspace_id"],
  });
}

export type SyncHealth = {
  /** A Search Console row exists for this workspace. */
  connected: boolean;
  connectedAt: string | null;
  /** The property the sync resolved, once it has. */
  siteUrl: string | null;
  /**
   * When a sync last completed: the recorded outcome (migration 115), or
   * else when the newest Search Console row was written. Null is "never".
   */
  lastSyncAt: string | null;
  /** The newest day Google has reported rows for. */
  latestMetricDate: string | null;
  /** The oldest day stored rows exist for. */
  earliestMetricDate: string | null;
  /**
   * The days the sync has an answer for, rows or not (migration 115): a day
   * Google reported as empty is inside it. Null without 115, or before the
   * first sync after it.
   */
  syncedFrom: string | null;
  syncedThrough: string | null;
  /** Google refused the stored token (migration 070); only a reconnect clears it. */
  needsReconnect: boolean;
  /** The provider error that set needsReconnect, or the last failed sync's. */
  lastSyncError: string | null;
};

export async function syncHealthFor(workspaceId: string): Promise<SyncHealth> {
  return syncHealthFrom(await createClient(), workspaceId);
}

/** The columns migration 115 adds, read on their own so a database without it still answers the rest. */
type SyncOutcome = { last_synced_at: string | null; synced_from: string | null; synced_through: string | null };

async function syncOutcome(supabase: SupabaseClient, workspaceId: string): Promise<SyncOutcome | null> {
  const { data, error } = await supabase
    .from("workspace_integrations")
    .select("last_synced_at, synced_from, synced_through")
    .eq("workspace_id", workspaceId)
    .eq("integration_id", "gsc")
    .maybeSingle();
  if (error || !data) return null;
  return data as SyncOutcome;
}

const later = (a: string | null, b: string | null) => (a && b ? (a > b ? a : b) : (a ?? b));

export async function syncHealthFrom(supabase: SupabaseClient, workspaceId: string): Promise<SyncHealth> {
  const [conn, lastWrite, latestMetricDate, earliestMetricDate, outcome] = await Promise.all([
    supabase
      .from("workspace_integrations")
      .select("connected_at, config, needs_reconnect, last_sync_error")
      .eq("workspace_id", workspaceId)
      .eq("integration_id", "gsc")
      .maybeSingle(),
    lastGscWriteAt(supabase, workspaceId),
    latestGscDate(supabase, workspaceId),
    earliestGscDate(supabase, workspaceId),
    syncOutcome(supabase, workspaceId),
  ]);
  const config = (conn.data?.config as { gscSiteUrl?: string } | null) ?? null;
  return {
    connected: Boolean(conn.data),
    connectedAt: (conn.data?.connected_at as string | null) ?? null,
    siteUrl: config?.gscSiteUrl ?? null,
    lastSyncAt: later(outcome?.last_synced_at ?? null, lastWrite),
    latestMetricDate,
    earliestMetricDate,
    syncedFrom: outcome?.synced_from ?? null,
    syncedThrough: outcome?.synced_through ?? null,
    needsReconnect: Boolean(conn.data?.needs_reconnect),
    lastSyncError: (conn.data?.last_sync_error as string | null | undefined) ?? null,
  };
}

/**
 * The days this site's Search Console history covers: the recorded sync
 * range, widened by the stored rows' own first and last day (which is all
 * there is without migration 115). lib/gsc/analysis.ts reads it to decide
 * whether a window is whole.
 */
export function coverageOf(health: Pick<SyncHealth, "syncedFrom" | "syncedThrough" | "earliestMetricDate" | "latestMetricDate">): GscCoverage {
  const earlier = (a: string | null, b: string | null) => (a && b ? (a < b ? a : b) : (a ?? b));
  return {
    from: earlier(health.syncedFrom, health.earliestMetricDate),
    through: later(health.syncedThrough, health.latestMetricDate),
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
  return knownPagesFrom(await createClient(), workspaceId);
}

export async function knownPagesFrom(supabase: SupabaseClient, workspaceId: string): Promise<KnownPageRow[]> {
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
