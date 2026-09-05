// ---------------------------------------------------------------------------
// A whole-site crawl through DataForSEO, and the reports it unlocks
// ---------------------------------------------------------------------------
//
// lib/seo/site-crawl.ts reads a site page by page and scores each one. It
// cannot answer anything that is only visible across the whole site: which two
// pages compete for the same term, which page nothing links to, which pages
// Google is told not to index, how many links are broken. Those need one
// crawler holding every page at once, which is what this is.
//
// The economics are unusual and worth stating, because they decide the design.
// Posting a crawl costs $0.00015 per page. Every report afterwards - links,
// duplicate content, duplicate tags, non-indexable, the summary - is FREE.
// Measured 2026-09-04: 50 pages of fitsuite.co cost $0.0075, and returned
// 3,771 links, 9 of them broken, 2 duplicate titles and 2 duplicate bodies.
// So the whole site for 3 cents, and asking it more questions costs nothing.
//
// Asynchronous, unavoidably: a crawl takes minutes. Post, poll, then read.
// Callers on a serverless function must post on one invocation and read on a
// later one rather than holding a request open - `postCrawl` returns the id
// for exactly that.

import { post } from "@/lib/seo/client";
import { isFault } from "./onpage";

export interface CrawlHandle {
  id: string;
  target: string;
}

export interface CrawlSummary {
  pagesCrawled: number;
  onPageScore: number | null;
  linksInternal: number | null;
  linksExternal: number | null;
  brokenLinks: number | null;
  brokenResources: number | null;
  duplicateTitle: number | null;
  duplicateDescription: number | null;
  duplicateContent: number | null;
  nonIndexable: number | null;
  /** Site-wide fault counts, already filtered to checks that mean a problem. */
  faults: Array<{ check: string; pages: number }>;
  finished: boolean;
}

/**
 * Destinations that are reported broken and are not.
 *
 * Cloudflare rewrites every mailto: on a protected site to
 * /cdn-cgi/l/email-protection and resolves it in the browser, so a crawler
 * sees a link that 404s. All nine "broken links" on fitsuite.co were this,
 * one per language plus the contact pages. Reporting them would send someone
 * to fix nine links that work.
 */
const FALSE_BROKEN = [/\/cdn-cgi\/l\/email-protection/i];

export interface BrokenLink {
  from: string;
  to: string;
  anchor: string | null;
}

/**
 * Start a crawl.
 *
 * `maxPages` is the cost. Resources and JavaScript are off: images and
 * stylesheets are not pages, and rendering multiplies the price for a signal
 * this set of reports does not use.
 */
export async function postCrawl(
  target: string,
  opts: { maxPages?: number } = {},
): Promise<CrawlHandle> {
  const res = await post<never>("/on_page/task_post", [
    {
      target,
      max_crawl_pages: opts.maxPages ?? 100,
      load_resources: false,
      enable_javascript: false,
      check_spell: false,
    },
  ]);
  const id = res.tasks?.[0]?.id;
  if (!id) throw new Error("On-Page task_post returned no task id");
  return { id, target };
}

/**
 * Read where a crawl has got to, and everything it knows so far.
 *
 * Safe to call while `finished` is false: the counts are simply partial. The
 * caller decides whether to wait, which is what lets a cron poll across
 * invocations instead of holding one open.
 */
export async function fetchSummary(handle: CrawlHandle): Promise<CrawlSummary> {
  const res = await post<SummaryResult>(`/on_page/summary/${handle.id}`, []).catch(() => null);
  const result = res?.tasks?.[0]?.result?.[0] ?? null;
  if (!result) {
    return {
      pagesCrawled: 0, onPageScore: null, linksInternal: null, linksExternal: null,
      brokenLinks: null, brokenResources: null, duplicateTitle: null,
      duplicateDescription: null, duplicateContent: null, nonIndexable: null,
      faults: [], finished: false,
    };
  }

  const m = result.page_metrics ?? {};
  // `checks` counts pages per check, and mixes health with harm: 50 pages
  // reporting `is_https` is good news. Only the fault-polarity ones are kept.
  const faults = Object.entries(m.checks ?? {})
    .filter(([name, pages]) => typeof pages === "number" && pages > 0 && isFault(name))
    .map(([check, pages]) => ({ check, pages: pages as number }))
    .sort((a, b) => b.pages - a.pages);

  return {
    pagesCrawled: result.crawl_status?.pages_crawled ?? 0,
    onPageScore: num(m.onpage_score),
    linksInternal: num(m.links_internal),
    linksExternal: num(m.links_external),
    brokenLinks: num(m.broken_links),
    brokenResources: num(m.broken_resources),
    duplicateTitle: num(m.duplicate_title),
    duplicateDescription: num(m.duplicate_description),
    duplicateContent: num(m.duplicate_content),
    nonIndexable: num(m.non_indexable),
    faults,
    finished: result.crawl_progress === "finished",
  };
}

/**
 * Every broken link on the site, and the page it sits on.
 *
 * Free, and not otherwise knowable: our own crawl checks the links of one
 * article at generation time, so a link that rotted afterwards on a page we
 * did not write is invisible to the product.
 */
export async function fetchBrokenLinks(
  handle: CrawlHandle,
  limit = 200,
): Promise<BrokenLink[]> {
  const res = await post<{ items?: LinkItem[] }>("/on_page/links", [
    {
      id: handle.id,
      limit,
      filters: [["is_broken", "=", true]],
    },
  ]);
  const items = res.tasks?.[0]?.result?.[0]?.items ?? [];
  return items
    .filter((i) => !FALSE_BROKEN.some((re) => re.test(i.link_to ?? "")))
    .map((i) => ({
      from: i.page_from ?? i.domain_from ?? "",
      to: i.link_to ?? i.domain_to ?? "",
      anchor: i.text?.trim() || null,
    }));
}

/**
 * Pages nothing on the site links to.
 *
 * An orphan is invisible to a crawler that arrives at the homepage, whatever
 * the sitemap says, and it receives no authority from the rest of the site.
 * Derived from the links report rather than fetched: every internal link's
 * destination is a page that is not an orphan, so the orphans are the crawled
 * pages that never appear as a destination.
 */
export async function fetchOrphanPages(
  handle: CrawlHandle,
  crawledUrls: string[],
): Promise<string[]> {
  const res = await post<{ items?: LinkItem[] }>("/on_page/links", [
    { id: handle.id, limit: 1000, filters: [["direction", "=", "internal"]] },
  ]);
  const items = res.tasks?.[0]?.result?.[0]?.items ?? [];
  const linkedTo = new Set(items.map((i) => normalise(i.link_to ?? "")));
  return crawledUrls.filter((u) => !linkedTo.has(normalise(u)));
}

function normalise(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return url.replace(/\/$/, "");
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

interface SummaryResult {
  crawl_progress?: string;
  crawl_status?: { pages_crawled?: number };
  page_metrics?: {
    onpage_score?: number;
    links_internal?: number;
    links_external?: number;
    broken_links?: number;
    broken_resources?: number;
    duplicate_title?: number;
    duplicate_description?: number;
    duplicate_content?: number;
    non_indexable?: number;
    checks?: Record<string, number | null>;
  };
}

interface LinkItem {
  direction?: string;
  is_broken?: boolean;
  page_from?: string;
  link_to?: string;
  domain_from?: string;
  domain_to?: string;
  text?: string;
}
