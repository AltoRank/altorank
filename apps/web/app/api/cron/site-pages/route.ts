import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cron-auth";
import { createServiceClient } from "@/lib/supabase/server";
import { entitledToScheduledWork, getQuota } from "@/lib/billing/quota";
import { syncSitePages, SitePagesWriteError } from "@/lib/seo/site-crawl";
import { detectLinks } from "@/lib/linking/detect";
import { observedCron } from "@/lib/observability/cron";
import { findDraftsLiveOnSites, type FoundOnSiteRun } from "@/lib/found-on-site/detect";

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
 *
 * It also hosts the found-on-site check (lib/found-on-site/detect.ts): did a
 * draft go live on the customer's own site without going through us? A real
 * signup (2026-09-22) published a draft on a site we were not connected to,
 * and nothing recorded it. That check reads the same kind of public
 * information - robots.txt, sitemaps, some HTML - so it lives here rather
 * than in a thirteenth daily cron (Vercel Hobby allows only daily schedules,
 * and this one already runs once a day). It goes first, with its own share
 * of the time: it is the daily question, while the crawl is weekly per site
 * and picks up tomorrow whatever it does not reach today.
 */

export const maxDuration = 300;

/** One site per run. Two would risk the second being cut off mid-upsert. */
const WORKSPACES_PER_RUN = 1;
/** Comfortably inside 300s at four concurrent fetches. */
const PAGES_PER_RUN = 120;
/** A page checked in the last week is not worth re-reading. */
const STALE_AFTER_DAYS = 7;
/** The found-on-site check's share of the run, every site together. */
const FOUND_ON_SITE_BUDGET_MS = 90_000;
/**
 * What the crawl may use, measured from the start of the run: 300 seconds less
 * room for the upsert and the link pass that follow it. Before the check
 * shared this route the crawl had the default 240 seconds to itself.
 */
const RUN_BUDGET_MS = 270_000;
const CRAWL_BUDGET_MS = 240_000;
const MIN_CRAWL_BUDGET_MS = 30_000;

async function run(request: Request) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();
  const startedAt = Date.now();

  // Its own failure is reported, never thrown: the crawl below does not
  // depend on it and must still run.
  let foundOnSite: FoundOnSiteRun | null = null;
  let foundOnSiteError: string | null = null;
  try {
    foundOnSite = await findDraftsLiveOnSites(supabase, { budgetMs: FOUND_ON_SITE_BUDGET_MS });
  } catch (err) {
    foundOnSiteError = err instanceof Error ? err.message : String(err);
  }
  const foundOnSiteReport = {
    found_on_site: foundOnSite?.found ?? 0,
    found_on_site_sites: foundOnSite?.checked ?? 0,
    found_on_site_deferred: foundOnSite?.deferred ?? 0,
    ...(foundOnSiteError ? { found_on_site_error: foundOnSiteError } : {}),
  };
  // One line per site the check looked at, in the same `results` list, so a
  // site it could not read - or the check failing outright - reaches
  // system_events as a warning like a crawl failure does. `job` tells the two
  // apart.
  const foundOnSiteResults: Array<Record<string, unknown>> = foundOnSiteError
    ? [{ job: "found-on-site", status: "error", detail: foundOnSiteError }]
    : (foundOnSite?.results ?? []).map((r) => ({ job: "found-on-site", ...r }));

  const staleBefore = new Date(Date.now() - STALE_AFTER_DAYS * 86_400_000).toISOString();

  // Never-crawled sites first, then the stalest. `first_analysed_at` gates on
  // the domain having been looked at at all, so a workspace created seconds
  // ago is not crawled before anyone has confirmed its domain.
  const { data: workspaces, error } = await supabase
    .from("workspaces")
    .select("id, domain, account_id, last_pages_crawl_at")
    .not("domain", "is", null)
    .not("first_analysed_at", "is", null)
    .neq("status", "paused")
    .or(`last_pages_crawl_at.is.null,last_pages_crawl_at.lt.${staleBefore}`)
    .order("last_pages_crawl_at", { ascending: true, nullsFirst: true })
    .limit(WORKSPACES_PER_RUN);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const results: Array<Record<string, unknown>> = [...foundOnSiteResults];

  for (const ws of workspaces ?? []) {
    const workspaceId = ws.id as string;
    const domain = ws.domain as string;

    // No provider bill here, but not free either: one workspace per run, up
    // to 120 page fetches, and the queue is ordered by staleness - so a
    // dormant free account takes a whole night's slot from a paying one. Same
    // rule as every other scheduled job (entitledToScheduledWork). Stamped
    // first, or the skipped workspace stays at the head of the queue forever
    // and no site is ever crawled again.
    const quota = await getQuota(supabase, ws.account_id as string, null);
    if (!entitledToScheduledWork(quota)) {
      await supabase
        .from("workspaces")
        .update({ last_pages_crawl_at: new Date().toISOString() })
        .eq("id", workspaceId);
      results.push({ workspaceId, domain, status: "skipped", detail: "no plan" });
      continue;
    }
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
        budgetMs: Math.max(
          MIN_CRAWL_BUDGET_MS,
          Math.min(CRAWL_BUDGET_MS, RUN_BUDGET_MS - (Date.now() - startedAt)),
        ),
      });
      await stamp();
      // The crawl just wrote titles and keywords for these pages; the link
      // pool picks them up now rather than on the next "Detect links" click.
      // Its own failure is reported, not thrown: the crawl above succeeded.
      let links: Record<string, unknown>;
      try {
        const detected = await detectLinks(supabase, workspaceId);
        links = { found: detected.found, added: detected.added };
      } catch (err) {
        links = { error: err instanceof Error ? err.message : "unknown error" };
      }
      results.push({
        workspaceId, domain, status: "crawled",
        discovered: summary.discovered,
        fetched: summary.fetched,
        failed: summary.failed,
        unchanged: summary.skipped,
        links,
      });
    } catch (err) {
      if (err instanceof SitePagesWriteError) {
        // The site was read but not stored. Stamping "now" would hide it for a
        // week with zero pages; leaving null would keep it at the head of the
        // queue ahead of never-crawled sites. Back-date the stamp so it is
        // eligible again on the next run, behind the genuinely new ones.
        await supabase
          .from("workspaces")
          .update({ last_pages_crawl_at: new Date(Date.now() - (STALE_AFTER_DAYS - 1) * 86_400_000).toISOString() })
          .eq("id", workspaceId);
        results.push({ workspaceId, domain, status: "error", detail: err.message, retry: "next run" });
        continue;
      }
      await stamp();
      results.push({
        workspaceId, domain, status: "error",
        detail: err instanceof Error ? err.message : "unknown error",
      });
    }
  }

  return NextResponse.json({ considered: workspaces?.length ?? 0, ...foundOnSiteReport, results });
}

/**
 * Every run of this job lands in `system_events` (lib/observability/cron.ts):
 * a throw or a 5xx as an error, per-item failures as a warning, and a clean
 * run as one `info` row — which is the only thing anywhere that proves the
 * schedule is still firing.
 */
export const GET = observedCron("cron.site_pages", run);
