import { NextResponse } from "next/server";
import { cronSecretFrom } from "@/lib/cron-auth";
import { createServiceClient } from "@/lib/supabase/server";
import { syncSitePages } from "@/lib/seo/site-crawl";

/**
 * Keep each site's published pages in step with its sitemap.
 *
 *   GET /api/cron/site-pages    header: x-cron-secret
 *
 * Reads public information only - a sitemap and some HTML - so it costs
 * nothing per page and needs no cooperation from the customer beyond having a
 * sitemap. What it produces is the thing the internal-link resolver was
 * missing: on a site that arrived with 204 posts, 204 link targets.
 *
 * Bounded twice over, because a serverless function has 300 seconds and a
 * large blog has more pages than that allows. One workspace per invocation,
 * stalest first, and a page cap inside it; whatever is not reached this run is
 * reached on the next, because ordering by `last_pages_crawl_at` is
 * self-healing.
 */

export const maxDuration = 300;

/** One site per run. Two would risk the second being cut off mid-upsert. */
const WORKSPACES_PER_RUN = 1;
/** Comfortably inside 300s at four concurrent fetches. */
const PAGES_PER_RUN = 120;
/** A page checked in the last week is not worth re-reading. */
const STALE_AFTER_DAYS = 7;

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || cronSecretFrom(request) !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();
  const staleBefore = new Date(Date.now() - STALE_AFTER_DAYS * 86_400_000).toISOString();

  // Never-crawled sites first, then the stalest. `first_analysed_at` gates on
  // the domain having been looked at at all, so a workspace created seconds
  // ago is not crawled before anyone has confirmed its domain.
  const { data: workspaces, error } = await supabase
    .from("workspaces")
    .select("id, domain, last_pages_crawl_at")
    .not("domain", "is", null)
    .not("first_analysed_at", "is", null)
    .neq("status", "paused")
    .or(`last_pages_crawl_at.is.null,last_pages_crawl_at.lt.${staleBefore}`)
    .order("last_pages_crawl_at", { ascending: true, nullsFirst: true })
    .limit(WORKSPACES_PER_RUN);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const results: Array<Record<string, unknown>> = [];

  for (const ws of workspaces ?? []) {
    const workspaceId = ws.id as string;
    const domain = ws.domain as string;
    // Stamped whatever happens, so a site whose sitemap cannot be read does
    // not become the permanent head of the queue.
    const stamp = async () =>
      supabase
        .from("workspaces")
        .update({ last_pages_crawl_at: new Date().toISOString() })
        .eq("id", workspaceId);

    try {
      const summary = await syncSitePages(supabase, workspaceId, domain, {
        maxPages: PAGES_PER_RUN,
      });
      await stamp();
      results.push({
        workspaceId, domain, status: "crawled",
        discovered: summary.discovered,
        fetched: summary.fetched,
        failed: summary.failed,
        unchanged: summary.skipped,
      });
    } catch (err) {
      await stamp();
      results.push({
        workspaceId, domain, status: "error",
        detail: err instanceof Error ? err.message : "unknown error",
      });
    }
  }

  return NextResponse.json({ considered: workspaces?.length ?? 0, results });
}
