import { balanceSources } from "@/lib/keyword-research/diversity";
import { languageCodeOf } from "@/lib/keyword-research/locale";
// ---------------------------------------------------------------------------
// First-look analysis for a domain nobody has connected yet
// ---------------------------------------------------------------------------
//
// Everything here reads public information: robots.txt, the sitemap, the HTML,
// the SERP. No CMS key, no OAuth, no DNS change, no cooperation from the site's
// owner at all. That is the whole point. The product's first useful output
// should not be gated behind an integration, because the integration is the
// step a prospect has not agreed to yet.
//
// It is also the shape of the MVP: a free check that produces findings specific
// enough to be worth paying to fix.
//
// Four layers, each independently degradable. A site that blocks crawlers still
// gets its readiness score; a workspace with no DataForSEO credentials still
// gets its crawl. Nothing here throws: a first look that half-worked is far
// more useful than an exception, and `layers` records exactly which half.

import type { SupabaseClient } from "@supabase/supabase-js";
import { recordingFetcher, runAgentReadiness, type ReadinessResult } from "./agent-readiness";
import { crawlSite, usablePages, type CrawlOptions } from "./crawler";
import { clearRefusal } from "./host-circuit";
import { decideFirstLook, firstLookPatch, type FirstLookDecision } from "./first-look";
import { runAuditChecks, calculateAuditScore } from "./checks";
import { pageFacts, type PageFacts } from "./page-facts";
import { fetchPageSpeedDetailed } from "./pagespeed";
import { type DiscoveredKeyword, storedCpc } from "@/lib/seo/keywords";
import { profileIsUsable, scoreRelevance, subjectVocabulary } from "@/lib/seo/topical-profile";
import type { BusinessProfile } from "@/lib/onboarding/business-profile";
import { assessKeywordQuality } from "@/lib/seo/recommendations";
import { discoverBuyerKeywords } from "@/lib/keyword-research/discovery";
import { isBrandTerm } from "@/lib/keyword-research/seeds";
import { judgeBuyerFit } from "@/lib/keyword-research/buyer-fit";
import { isOutOfReach, isHopeless } from "@/lib/seo/difficulty";
import { hasDataForSEOCredentials } from "@/lib/seo/client";
import { dedupePermutations, dedupeTargets } from "@/lib/seo/keywords";
import {
  fetchRankedKeywords,
  groupByPage,
  strikingDistance,
  type RankedKeyword,
} from "@/lib/seo/ranked-keywords";
import { classifyIntent } from "@/lib/seo/intent";
import { buildTopicalProfile, type TopicalProfile } from "@/lib/seo/topical-profile";
import { detectPlatform, type Detection } from "@/lib/cms/detect";
import { discoverUrls } from "@/lib/seo/site-crawl";
import { syncBacklinks } from "@/lib/seo/backlinks";
import { fetchDomainMetrics } from "@/lib/seo/domain-metrics";
import { e2eStubsEnabled, stubAnalyseDomain } from "@/lib/e2e/stubs";

export interface AnalysisLayer {
  id: "readiness" | "crawl" | "pagespeed" | "platform" | "keywords" | "ranked_keywords" | "backlinks" | "authority" | "category";
  status: "ok" | "unavailable" | "failed";
  detail: string;
}

export interface DomainAnalysis {
  domain: string;
  readiness: ReadinessResult | null;
  /** Vocabulary the site actually uses, for scoring keyword relevance. */
  topicalProfile: TopicalProfile | null;
  pagesCrawled: number;
  auditScore: number | null;
  issues: unknown[];
  pagespeed: Record<string, unknown>;
  keywordsFound: number;
  /** Keywords the domain ranks for today, joined to the page that earns them. */
  rankedKeywords: RankedKeyword[];
  /** Of those, the ones close enough to page one to be worth a revision. */
  strikingDistance: RankedKeyword[];
  /** DataForSEO's domain rank mapped to 0-100. Null when unmeasured. */
  authority: number | null;
  /** Estimated monthly organic visits. Null when unmeasured. */
  traffic: number | null;
  /** What the site publishes with, read off the homepage. */
  platform: string | null;
  layers: AnalysisLayer[];
  /** One-line summary for a human skimming the workspace. */
  headline: string;
  /**
   * What this run did to the workspace's first-look state. Only set when the
   * analysis was persisted (a `supabase` + `workspaceId` caller); undefined
   * for the read-only callers that pass neither.
   */
  firstLook?: FirstLookDecision;
}

/** A discovered keyword plus, for a gap row, the rival that holds it. */
type Sourced = DiscoveredKeyword & { competitor?: string };

/** The wizard's answers, as `analyseDomain` needs them. */
type BusinessProfileFields = {
  name?: string | null;
  description?: string | null;
  audiences?: string[] | null;
  offerings?: string[] | null;
  competitors?: string[] | null;
  language?: string | null;
};

/** Bounded so a first look cannot become an hour-long crawl of a huge site. */
const MAX_PAGES = 40;
const MAX_DEPTH = 2;
const CRAWL_DELAY_MS = 400;
const MAX_KEYWORDS_STORED = 100;

/**
 * Below this many sitemap URLs the sitemap is not used to judge whose page a
 * ranking belongs to.
 *
 * A small or partial sitemap is normal and says nothing; a large one is the
 * site enumerating what it considers its own content, and a ranked URL missing
 * from it is the interesting case (see `rankedOnOwnPages`).
 */
export const SITEMAP_TRUST_MIN = 100;

function pathOf(url: string): string | null {
  try {
    return (new URL(url, "https://placeholder.invalid").pathname.replace(/\/+$/, "") || "/").toLowerCase();
  } catch {
    return null;
  }
}

/** The paths a sitemap declares, or null when it is too small to trust. */
export function ownPagePaths(sitemapUrls: string[]): Set<string> | null {
  if (sitemapUrls.length <= SITEMAP_TRUST_MIN) return null;
  const paths = new Set<string>();
  for (const url of sitemapUrls) {
    const path = pathOf(url);
    if (path) paths.add(path);
  }
  return paths.size ? paths : null;
}

/**
 * Ranked rows earned by pages the site itself lists.
 *
 * WHY: on a multi-tenant host the domain ranks for its customers' content, and
 * the queue read that as the business's own subject matter. buttondown.com - a
 * newsletter platform - ranks for "taffy danoff", "bald nba players" and
 * "online casinos switzerland" through pages its subscribers wrote, and every
 * one of them is exempt from the relevance filter because "the SERP already
 * decided" (recommendations.ts). The plan it produced was for its tenants.
 * Substack, Medium, github.io and any Shopify store carrying customer blogs
 * have the same shape.
 *
 * A sitemap is the site saying which pages are its own. A ranking on a page it
 * does not list is somebody else's ranking.
 *
 * `paths` null means the sitemap could not be trusted to answer (missing,
 * small, or a walk that ran out of time), and then nothing is dropped: the
 * absence of a sitemap entry is only evidence when the sitemap is complete.
 * A row with no URL is never dropped either - it cannot be judged.
 */
export function rankedOnOwnPages(
  ranked: RankedKeyword[],
  paths: Set<string> | null,
): RankedKeyword[] {
  if (!paths) return ranked;
  return ranked.filter((k) => {
    if (!k.url) return true;
    const path = pathOf(k.url);
    return path === null || paths.has(path);
  });
}

/** Wall-clock ceiling on the sitemap walk. It runs inside a 300s worker that
 *  has already spent 60-170s here, so it gives up rather than compete. */
const SITEMAP_WALK_MS = 12_000;

/**
 * The paths this site declares as its own, or null when it did not answer
 * well enough to be used as evidence.
 *
 * Null on a quick look (no budget, and the growth plan does not store
 * keywords), when nothing ranks (nothing to judge), when the walk ran out of
 * time (a partial list would drop real pages), and when the sitemap is small
 * (SITEMAP_TRUST_MIN). Never throws: no sitemap means no filtering, which is
 * the behaviour that existed before this.
 */
async function ownSitemapPaths(
  domain: string,
  depth: "quick" | "full",
  rankedCount: number,
  /** robots.txt and sitemap bodies the readiness check already fetched. */
  bodies?: ReadonlyMap<string, string>,
): Promise<Set<string> | null> {
  if (depth !== "full" || rankedCount === 0) return null;
  const maxUrls = 5_000;
  const deadline = Date.now() + SITEMAP_WALK_MS;
  try {
    const urls = await discoverUrls(domain, { timeoutMs: 6_000, maxUrls, deadline, bodies });
    // Both of these mean the list is a prefix of the sitemap rather than the
    // sitemap, and a prefix would drop the site's own pages as somebody
    // else's. Out of time, or stopped at the ceiling.
    if (Date.now() >= deadline || urls.length >= maxUrls) return null;
    return ownPagePaths(urls);
  } catch {
    return null;
  }
}

/** Ranked rows already on page one are the ones with nothing left to win. */
const PAGE_ONE = 10;
/**
 * Most of the stored list one source may take.
 *
 * A site with 500 ranking terms filled all 100 slots with page-one rankings,
 * every one of which `recommendKeywords` then marked "already ranking at
 * position N, leave it alone". `pickNextKeyword` found nothing and the run
 * ended "Nothing scheduled yet" - after paying for the gap and seed calls
 * whose rows never reached the table (round4 R4-2, F2). Half the list is
 * reserved for rows that can still be written to; page-one rankings backfill
 * whatever is left, so a site that ranks for nothing else still gets 100.
 */
export const PAGE_ONE_RANKED_CAP = MAX_KEYWORDS_STORED / 2;

/**
 * Take `limit` candidates, reserving room for rows that are not already won.
 *
 * Order within each group is the caller's; this only defers the surplus of
 * already-won rows to the end rather than dropping them.
 */
export function takeReservingSlots<T>(
  candidates: T[],
  limit: number,
  isAlreadyWon: (c: T) => boolean,
  cap: number = PAGE_ONE_RANKED_CAP,
): T[] {
  const kept: T[] = [];
  const deferred: T[] = [];
  let won = 0;
  for (const c of candidates) {
    if (kept.length >= limit) break;
    if (isAlreadyWon(c)) {
      if (won >= cap) {
        deferred.push(c);
        continue;
      }
      won++;
    }
    kept.push(c);
  }
  for (const c of deferred) {
    if (kept.length >= limit) break;
    kept.push(c);
  }
  return kept;
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/**
 * Analyse a domain and store what it finds.
 *
 * `supabase` and `workspaceId` are optional: without them this is a pure
 * read-only analysis, which is what the sales-side "check any domain" path
 * needs. With them, results are persisted to `domain_audits` and discovered
 * keywords are inserted for the workspace.
 */
/**
 * Did every fetch fail for a reason that is likely to be different in a few
 * seconds?
 *
 * packhub.io, 2026-09-09 18:38:05: ten seconds after the wizard had read the
 * homepage from the same Vercel function, the crawl got status 0 on every
 * page and the readiness check got nothing, while the PageSpeed and DataForSEO
 * calls in the same invocation succeeded. The site answers in half a second
 * and allows the crawler's user agent; a profile refresh read eight pages
 * eleven minutes later. One attempt, a ten-second timeout, and no second try
 * turned a blip into "too little readable text on the site", a stamped
 * `first_analysed_at`, and a customer typing keywords by hand.
 *
 * A host that does not resolve, a certificate Node will not accept, or an HTTP
 * refusal are not blips; retrying those spends time on the same answer.
 */
export function isTransientCrawlFailure(reason: string | null | undefined): boolean {
  if (!reason) return false;
  const r = reason.toLowerCase();
  // 429 and the 5xx family are the server saying "not now": a burst limit
  // tripped by the wizard's own reads seconds earlier, or a cold instance.
  // Every other HTTP status is an answer, and the same one tomorrow.
  if (/^http (429|502|503|504)\b/.test(r)) return true;
  if (r.includes("host not found") || r.includes("tls certificate") || /^http \d{3}/.test(r)) return false;
  return (
    r.includes("timed out") ||
    r.includes("econnreset") ||
    r.includes("econnrefused") ||
    r.includes("etimedout") ||
    r.includes("eai_again") ||
    r.includes("socket hang up") ||
    r.includes("fetch failed")
  );
}

/** Between attempts. Short: the wizard's minute is running while this waits. */
export const CRAWL_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000];

/**
 * `crawlSite`, tried again when every page failed for a transient reason.
 *
 * Returns the pages of the last attempt and how many attempts it took, so the
 * crawl layer can say "3 attempts" and the persist step can tell a look that
 * happened from one that did not.
 */
/**
 * How long a rate ban lasts on the one host it has been measured on:
 * packhub.io answered 403 for about forty seconds after its tenth request,
 * then 200 again. Waiting it out once costs less than the first look it
 * would otherwise cost the customer.
 */
/** The 2xx bodies a recording fetcher holds, by URL, for callers that take bodies. */
function recordedBodies(resources: ReadonlyMap<string, { status: number; body: string }>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [url, r] of resources) if (r.status >= 200 && r.status < 300 && r.body) out.set(url, r.body);
  return out;
}

export const RATE_BAN_WAIT_MS = 45_000;

/** A refused page: the host's rule, not the page's absence. */
const isRefused = (p: { status: number }) => p.status === 403 || p.status === 429;

async function crawlWithRetry(
  baseUrl: string,
  maxPages: number,
  maxDepth: number,
  delayMs: number,
  retryDelays: readonly number[] = CRAWL_RETRY_DELAYS_MS,
  crawlOpts: CrawlOptions = {},
  /** Null: never wait for a ban (the quick look). 0: retry without sleeping (tests). */
  rateBanWaitMs: number | null = RATE_BAN_WAIT_MS,
): Promise<{ fetched: Awaited<ReturnType<typeof crawlSite>>; attempts: number; rateLimited: boolean }> {
  let fetched = await crawlSite(baseUrl, maxPages, maxDepth, delayMs, crawlOpts);
  let attempts = 1;
  let rateLimited = false;

  // Every page refused before one was read: the ban was already in force
  // when the crawl began (the wizard's reader and the readiness check spent
  // the budget). Wait the window out once, then read what a short crawl can.
  if (fetched.length > 0 && usablePages(fetched).length === 0 && fetched.every(isRefused) && rateBanWaitMs !== null) {
    rateLimited = true;
    if (rateBanWaitMs > 0) await new Promise((r) => setTimeout(r, rateBanWaitMs));
    // The window has been waited out in silence; the next request is fresh.
    clearRefusal(baseUrl);
    fetched = await crawlSite(baseUrl, Math.min(maxPages, 6), maxDepth, Math.max(delayMs, 1_500), crawlOpts);
    attempts += 1;
    return { fetched, attempts, rateLimited };
  }

  for (const wait of retryDelays) {
    const failedEverywhere = fetched.length > 0 && usablePages(fetched).length === 0;
    const reason = fetched.find((p) => p.error)?.error ?? null;
    if (!failedEverywhere || !isTransientCrawlFailure(reason)) break;
    await new Promise((r) => setTimeout(r, wait));
    fetched = await crawlSite(baseUrl, maxPages, maxDepth, delayMs, crawlOpts);
    attempts += 1;
  }
  // Read some, then refused: the crawler stopped itself (crawler.ts).
  if (usablePages(fetched).length > 0 && fetched.some((p) => isRefused(p) && /rate-limits/.test(p.error ?? ""))) rateLimited = true;
  return { fetched, attempts, rateLimited };
}

export async function analyseDomain(options: {
  domain: string;
  supabase?: SupabaseClient;
  workspaceId?: string;
  locale?: string;
  /**
   * How much to do. "full" crawls up to 40 pages, builds the topical profile
   * and discovers keywords: the right depth once a workspace exists. "quick"
   * reads the homepage only, for the public growth plan, where the visitor is
   * waiting and every call is unpaid.
   *
   * Both run the same code, so the free check on the marketing site and the
   * first look inside the app can never disagree about a domain (2026-09-02).
   */
  depth?: "quick" | "full";
  /**
   * What the wizard learned about the business, when a workspace has it.
   *
   * Until 2026-09-08 this never crossed the boundary: the keyword phase seeded
   * itself from page headings alone (`seedPhrasesFromPages`), so the model's
   * own reading of the company - the description, and every audience the
   * person confirmed - could never propose a candidate. Measured on
   * qasimcode.com, whose profile says "appointment-based websites for clinics,
   * salons, studios and trades, with online booking": not one of its 20 stored
   * keywords contained book, appoint, clinic, salon, dental, therapy, trade or
   * calendar. The relevance filter downstream can only reject; it cannot
   * introduce "salon booking website" when nothing proposed it.
   */
  profile?: BusinessProfile | null;
  /** The workspace's search market, e.g. 2380 for Italy. Paired with `locale`. */
  locationCode?: number;
  /** Waits between crawl attempts. Tests pass []; production takes the default. */
  crawlRetryDelaysMs?: readonly number[];
  /**
   * Pages the crawl may read this run. The onboarding minute passes a small
   * number: a voice and a vocabulary come from a dozen pages, the nightly
   * pass reads the rest, and every page is one request against a host that
   * may be counting them.
   */
  maxPages?: number;
  /** How long to wait once when a host rate-bans the crawl. Tests pass 0. */
  rateBanWaitMs?: number;
  /**
   * `workspaces.analysis_attempts` as the caller read it, so a run that reads
   * nothing can count itself. See lib/audit/first-look.ts. Omitted by callers
   * that run once per workspace (onboarding), which is the same as 0.
   */
  analysisAttempts?: number;
}): Promise<DomainAnalysis> {
  // E2E_STUBS: fixture keywords, no crawl, no provider, nothing measured (lib/e2e/stubs.ts).
  if (e2eStubsEnabled()) return stubAnalyseDomain(options);
  const domain = normalizeDomain(options.domain);
  const { supabase, workspaceId } = options;
  const depth = options.depth ?? "full";
  const baseUrl = `https://${domain}`;
  const layers: AnalysisLayer[] = [];

  // --- Agent readiness -----------------------------------------------------
  // What readiness fetches - the homepage, robots.txt, the sitemap - the crawl
  // and URL discovery need too. One fetcher remembers them, so a host that
  // counts requests sees each once.
  const recorded = recordingFetcher();
  let readiness: ReadinessResult | null = null;
  try {
    const result = await runAgentReadiness(domain, recorded);
    if (result.error) {
      layers.push({ id: "readiness", status: "failed", detail: result.error });
    } else {
      readiness = result;
      const failing = result.findings.filter((f) => !f.passed).length;
      layers.push({
        id: "readiness",
        status: "ok",
        detail: `score ${result.score}/100, ${failing} of ${result.findings.length} checks failing`,
      });
    }
  } catch (err) {
    layers.push({
      id: "readiness",
      status: "failed",
      detail: err instanceof Error ? err.message : "readiness check failed",
    });
  }

  // --- Crawl + on-page checks ----------------------------------------------
  let pagesCrawled = 0;
  let crawlAttempts = 1;
  let crawlRateLimited = false;
  let homeFacts: PageFacts | null = null;
  let auditScore: number | null = null;
  let issues: unknown[] = [];
  let profile: TopicalProfile | null = null;
  try {
    const home = recorded.resources.get(`${baseUrl}/`) ?? recorded.resources.get(baseUrl);
    const seedHtml = home && home.status >= 200 && home.status < 300 && /<html/i.test(home.body) ? home.body : null;
    // The homepage's own account of itself, off the bytes already fetched.
    // Persisted with the audit for the onboarding report (page-facts.ts).
    if (seedHtml && home) homeFacts = pageFacts(seedHtml, home.headers, home.status);
    const { fetched, attempts, rateLimited } = await crawlWithRetry(
      baseUrl,
      depth === "quick" ? 1 : Math.min(options.maxPages ?? MAX_PAGES, MAX_PAGES),
      depth === "quick" ? 0 : MAX_DEPTH,
      CRAWL_DELAY_MS,
      options.crawlRetryDelaysMs ?? CRAWL_RETRY_DELAYS_MS,
      { seedHtml },
      depth === "quick" ? null : (options.rateBanWaitMs ?? RATE_BAN_WAIT_MS),
    );
    crawlAttempts = attempts;
    crawlRateLimited = rateLimited;
    const pages = usablePages(fetched);
    pagesCrawled = pages.length;
    if (!pages.length && fetched.length) {
      // Every fetch failed. Say why, and score nothing: the first version of
      // this gave www.lully.ai a 95/100 on-page score and a topical profile of
      // {"www"} from a fetch that never got a response.
      const why = fetched.find((p) => p.error)?.error ?? `HTTP ${fetched[0].status}`;
      layers.push({
        id: "crawl",
        status: "failed",
        detail: `no page could be fetched: ${why}` + (crawlAttempts > 1 ? ` (${crawlAttempts} attempts)` : ""),
      });
    } else if (pages.length) {
      // Built here because this is the only point that holds the page content.
      // Recommendations need it on every run and must not re-crawl to get it.
      profile = buildTopicalProfile(domain, pages);
      issues = runAuditChecks(pages) as unknown[];
      auditScore = calculateAuditScore(issues as never, pages.length);
      layers.push({
        id: "crawl",
        status: "ok",
        detail:
          `${pages.length} pages crawled, ${issues.length} issues, ` +
          (auditScore === null ? "not scored" : `score ${auditScore}/100`) +
          (crawlRateLimited ? "; the site rate-limits crawlers, so this run read fewer pages and the nightly pass reads the rest" : ""),
      });
    } else {
      layers.push({
        id: "crawl",
        status: "failed",
        detail: "no pages could be crawled (blocked, redirected off-domain, or JavaScript-rendered)",
      });
    }
  } catch (err) {
    layers.push({
      id: "crawl",
      status: "failed",
      detail: err instanceof Error ? err.message : "crawl failed",
    });
  }

  // --- PageSpeed -----------------------------------------------------------
  let pagespeed: Record<string, unknown> = {};
  const ps = depth === "full" ? await fetchPageSpeedDetailed(baseUrl) : { ok: false as const, kind: "unavailable" as const, detail: "not run on a quick look" };
  if (ps.ok) {
    // PageSpeedResult is a fixed shape; the column is jsonb, so it is stored
    // as a plain object rather than reshaped.
    pagespeed = { ...ps.result };
    layers.push({
      id: "pagespeed",
      status: "ok",
      detail:
        `performance ${ps.result.performanceScore}/100, ` +
        `LCP ${(ps.result.largestContentfulPaint / 1000).toFixed(1)}s, ` +
        `CLS ${ps.result.cumulativeLayoutShift.toFixed(3)}`,
    });
  } else {
    // Why it did not run, kept with the audit so the report can say so
    // instead of showing an empty card.
    pagespeed = { unavailable: ps.detail };
    layers.push({ id: "pagespeed", status: ps.kind, detail: ps.detail });
  }

  // --- What the site publishes with ----------------------------------------
  //
  // One public GET, so it runs before anyone has connected anything. This is
  // the question onboarding used to make the user answer from a dropdown of
  // twelve, and the site can usually answer it itself.
  let detection: Detection | null = null;
  try {
    detection = await detectPlatform(domain);
    layers.push({
      id: "platform",
      status: detection ? "ok" : "unavailable",
      detail: detection
        ? `${detection.platform} (${detection.confidence} confidence, ${detection.evidence})`
        : "could not identify the platform from public signals",
    });
  } catch {
    layers.push({
      id: "platform",
      status: "failed",
      detail: "platform detection failed",
    });
  }

  const hasDataForSeo = hasDataForSEOCredentials();

  // --- What the domain already ranks for ------------------------------------
  // Separate layer from `keywords` above on purpose. That one answers "what
  // could this site target"; this one answers "what does it rank for today, on
  // which of its pages". The second is what makes a first look feel like it is
  // about them rather than about their industry, and it is the input
  // `recommendKeywords` scores highest: striking distance is its largest
  // multiplier, and without rank data that branch can never fire on a prospect.
  let ranked: RankedKeyword[] = [];
  let rankedPages = 0;
  // Distinguishes "the lookup ran and returned nothing" from "the lookup never
  // ran". Persisted as [] versus NULL, because a domain nobody could look up is
  // not a domain that ranks for nothing.
  let rankedLayerRan = false;
  if (!hasDataForSeo) {
    layers.push({
      id: "ranked_keywords",
      status: "unavailable",
      detail: "DataForSEO credentials not configured",
    });
  } else {
    try {
      ranked = await fetchRankedKeywords(domain, { languageCode: languageCodeOf(options.locale), locationCode: options.locationCode });
      rankedLayerRan = true;
      rankedPages = groupByPage(ranked).size;
      const close = strikingDistance(ranked);

      layers.push({
        id: "ranked_keywords",
        status: "ok",
        detail: ranked.length
          ? `${ranked.length} ranking keywords across ${rankedPages} pages` +
            (close.length ? `, ${close.length} in striking distance` : "")
          : // Zero rows is the failure mode two sibling parsers hid for months,
            // so it is reported as its own state rather than as a quiet success.
            "no ranking keywords returned for this domain",
      });
    } catch (err) {
      layers.push({
        id: "ranked_keywords",
        status: "failed",
        detail: err instanceof Error ? err.message : "rank lookup failed",
      });
    }
  }

  // --- What to write next --------------------------------------------------
  //
  // Three sources, in order of how much they know about this site:
  //
  //   1. what it already ranks for   observed on the live SERP, with the
  //                                  position, so "one revision from page
  //                                  one" is answerable
  //   2. ideas seeded from its own   headings, which say what the business
  //      pages                       does in its own words
  //   3. Google Ads keywords-for-    an advertising tool, and the source of
  //      site                        every junk set we have shipped:
  //                                  "artificial artificial intelligence"
  //                                  for a warehouse company, "ai stop" for
  //                                  supalabs.co. Fallback only, when the
  //                                  first two leave the queue too thin.
  //
  // Reordered 2026-09-02. Before this, (3) was the primary source and (1) was
  // fetched for a headline and thrown away, so the strongest signal in the
  // product never reached the queue that decides what gets written.
  //
  // --- Authority, measured BEFORE the keywords rather than after -----------
  //
  // The same call, in the same run, moved thirty lines up. It used to sit
  // below, which meant that on a first analysis - every signup - the keyword
  // filters ran with `workspaces.dr` still null and could not ask whether a
  // keyword was reachable for this particular site. qasimcode.com was given
  // five KD 100 keywords and eight at KD 70 or worse on a domain whose
  // authority this run measured, eleven seconds later, as 0.
  //
  // The layer is built here and pushed in its original position below, so the
  // run screen still reads readiness, crawl, keywords, authority.
  let authority: number | null = null;
  let traffic: number | null = null;
  let referringDomains: number | null = null;
  let authorityLayer: AnalysisLayer | null = null;
  if (hasDataForSeo) {
    try {
      // Location travels with language or the pair is rejected. This passed
      // the workspace's language and let the location default to the United
      // States, so an Italian site asked for Italian results in the US and
      // DataForSEO answered "Invalid Field: 'language_code'" - which reads
      // like the field is wrong rather than the combination. Traffic was
      // therefore null on every non-English workspace (2026-09-04).
      const m = await fetchDomainMetrics(domain, {
        languageCode: languageCodeOf(options.locale),
        locationCode: options.locationCode,
      });
      authority = m.authority;
      traffic = m.traffic;
      referringDomains = m.referringDomains;
      if (supabase && workspaceId && (m.authority !== null || m.traffic !== null)) {
        await supabase
          .from("workspaces")
          .update({
            ...(m.authority !== null ? { dr: m.authority } : {}),
            ...(m.traffic !== null ? { traffic: m.traffic } : {}),
          })
          .eq("id", workspaceId);
      }
      authorityLayer = {
        id: "authority",
        status: m.authority === null && m.traffic === null ? "unavailable" : "ok",
        detail:
          m.authority === null && m.traffic === null
            ? "no authority or traffic estimate returned for this domain"
            : `authority ${m.authority ?? "—"}, ${m.traffic?.toLocaleString() ?? "—"} organic visits a month`,
      };
    } catch (err) {
      authorityLayer = { id: "authority", status: "failed", detail: err instanceof Error ? err.message : "authority lookup failed" };
    }
  }

  // What the person confirmed in the wizard: what they sell, who to, and
  // against whom.
  //
  // `options.profile` is the signup path (#180 wired it through the wizard).
  // The fallback read is for every other caller - `cron/analyze` re-analyses a
  // workspace nightly and has no profile in hand, and it needs the subject test
  // as much as the first run does. Null on a workspace that skipped the wizard,
  // which disables that test rather than failing it.
  let business: BusinessProfileFields | null = options.profile ?? null;
  if (!business && supabase && workspaceId) {
    try {
      const { data } = await supabase
        .from("workspaces")
        .select("business_profile")
        .eq("id", workspaceId)
        .single();
      business = (data?.business_profile as BusinessProfileFields | null) ?? null;
    } catch {
      // Nothing here throws. A workspace whose profile cannot be read gets the
      // page-seed-only behaviour it had before this existed.
      business = null;
    }
  }

  let keywordsFound = 0;
  if (!hasDataForSeo) {
    layers.push({
      id: "keywords",
      status: "unavailable",
      detail: "DataForSEO credentials not configured",
    });
  } else {
    try {
      // An inner function so the "nothing readable here" case can stop at the
      // first line instead of nesting the whole phase in an `if`. The layers
      // and metrics below still run: this skips the keyword discovery, not
      // the analysis.
      await (async () => {
        const usable = profileIsUsable(profile, domain);
        // Nothing readable, nothing to judge against, nothing bought.
        //
        // The relevance filter below is the only thing standing between a
        // provider's raw output and this workspace's keyword table, and until
        // 2026-09-07 it was disabled in precisely the case it exists for: `rel`
        // returned 1 for every term when there was no profile, so `!usable` let
        // everything through. Measured on example.com - a 1 KB page the product
        // had just told the customer it "could not read enough of" - that
        // stored 100 keywords ("ry domain", "explam", "hotel best auto hogar
        // barcelona"), planned 30 articles and wrote seven of them, for $1.63.
        //
        // Ranked rows are dropped with the rest. They were exempt because "the
        // SERP already decided" a term is on-topic, and that holds for a site
        // with a real footprint; on a site with no readable text they are the
        // junk itself. Every one of example.com's 100 was a ranked row.
        //
        // The paid calls below are skipped too - the competitor gap, the seeded
        // expansion, the Ads fallback - because there is nowhere for their
        // results to go. The workspace gets the layers it has already paid for
        // (readiness, crawl, PageSpeed, authority) and a keyword phase that
        // says why it is empty; `lib/onboarding/pipeline.ts` turns that into
        // the honest run screen a site with no DNS already gets.
        if (!usable) {
          layers.push({
            id: "keywords",
            status: "unavailable",
            detail:
              "too little readable text on the site to tell an on-topic keyword from an off-topic one, so none were stored",
          });
          return;
        }
        const subject = subjectVocabulary(business, profile);
        const rel = (term: string) => scoreRelevance(term, profile, subject).score;


        // (1) Ranked terms, best position first - but only the ones earned by
        // pages the site lists as its own. See `rankedOnOwnPages`: on a
        // multi-tenant host the rest are its customers' rankings, and they are
        // exempt from every relevance filter downstream because the SERP already
        // decided. The headline "N ranking keywords" above is untouched: those
        // pages do rank on this domain. This is about whose subject matter goes
        // into the queue.
        const ownPages = await ownSitemapPaths(domain, depth, ranked.length, recordedBodies(recorded.resources));
        const rankedOwn = rankedOnOwnPages(ranked, ownPages);
        const rankedDropped = ranked.length - rankedOwn.length;
        // A ranking is not a licence to store a rival's name. qasimcode.com
        // ranks somewhere for "wix" and "acuity" because its blog writes about
        // rescuing sites off them; both were stored as things to target, and
        // both name a competitor the person had just listed in the wizard.
        // The brand filter applied to the other two sources, never to this one.
        const brandNames = [...new Set((business?.competitors ?? []).map((c) => c))];
        const fromRanked: DiscoveredKeyword[] = rankedOwn
          .filter((k) => k.position !== null && !isBrandTerm(k.keyword, domain, brandNames))
          .map((k) => ({
            keyword: k.keyword,
            volume: k.volume ?? 0,
            difficulty: k.difficulty,
            cpc: k.cpc ?? 0,
            competition: 0,
            intent: k.intent ?? classifyIntent(k.keyword, options.locale ?? "en").intent,
            sourceUrl: k.url,
          }));

        // (2) What the rivals the person named rank for, and (3) the category
        // around what a buyer of this business types, proposed from the
        // profile and expanded in one call (lib/keyword-research/discovery.ts
        // says why these two replaced the competitor gap, the heading seeds
        // and the Google Ads fallback on 2026-09-11). A quick run buys neither.
        const spend = supabase && workspaceId ? { supabase, workspaceId } : null;
        const discovered =
          depth === "full"
            ? await discoverBuyerKeywords({
                domain,
                business,
                languageCode: languageCodeOf(options.locale),
                locationCode: options.locationCode,
                spend,
              })
            : { fromCompetitors: [], fromIdeas: [], seeds: { seeds: [], basis: "none" as const }, seedsPriced: 0, competitorsAsked: [] };
        const fromCompetitors = discovered.fromCompetitors;
        const fromIdeas = discovered.fromIdeas;

        // Position per ranked term, for the reserve rule below.
        const positionByTerm = new Map<string, number | null>();
        for (const k of ranked) positionByTerm.set(k.keyword.trim().toLowerCase(), k.position);

        const byTerm = new Map<string, { k: Sourced; rank: number }>();
        const add = (k: Sourced, rank: number) => {
          const key = k.keyword.trim().toLowerCase();
          const prev = byTerm.get(key);
          if (!prev || rank < prev.rank) byTerm.set(key, { k, rank });
        };
        for (const k of fromRanked) add(k, 0);
        for (const k of fromCompetitors) add(k, 1);
        for (const k of fromIdeas) add(k, 2);

        // The buyer test, once, over EVERY candidate - including the terms the
        // site already ranks for.
        //
        // Those used to be exempt, on the reasoning that a ranking is a test
        // result the SERP already ran. That holds for a site whose pages are
        // about what it sells, and fails for one whose blog is about the trade:
        // qasimcode.com sells fixed-price websites to clinics and salons, and
        // its 1,606 write-ups rank it somewhere for "wix", "web sites" and four
        // phrasings of "free portfolio website". Ranking #80 for a phrase
        // because you wrote about it is not evidence a buyer typed it.
        //
        // Judge all candidates in bounded batches, strongest lexical matches
        // first. Missing decisions cannot enter the automatic writing pool.
        const toJudge = [...byTerm.values()]
          .sort((a, b) => rel(b.k.keyword) - rel(a.k.keyword))
          .map((c) => c.k.keyword);
        const fit = await judgeBuyerFit(business, toJudge, { spend });
        const refusedByBuyerTest = [...fit.verdicts.values()].filter((v) => !v.keep).length;

        // Collapse phrasings across ALL three sources, not just the seeded one.
        // keyword_suggestions is the worst offender but keywords_for_site emits
        // the same shape: altorank.co came back with "seo for agency", "agency
        // for seo" and "seo agent" as three separate rows at 27,100 each.
        //
        // Two passes, because `permutationKey` and `normalizeTarget` disagree
        // about what one query is and both are right about part of it.
        // `permutationKey` keeps the words as typed, so it collapses "seo for
        // agency" and "agency for seo" but not "website design" and "website
        // design websites". `normalizeTarget` folds plurals, gerunds, agent
        // nouns and a silent final "e", which is what makes those one target -
        // and it is already what `recommendKeywords` collapses on, so anything
        // it merges downstream was a wasted row here anyway. qasimcode.com
        // stored twenty rows that are thirteen queries; four of them were
        // "website design" and two more were "create"/"creating".
        const candidatesAll = [...byTerm.values()];
        const deduped = dedupeTargets(dedupePermutations(candidatesAll.map((c) => c.k)));
        const keep = new Set(deduped.map((k) => k.keyword));
        const candidates = candidatesAll.filter((c) => keep.has(c.k.keyword));
        // Overwritten below with what actually passes the quality and relevance
        // filters; the wizard said "Found 8" while 3 rows were stored.
        keywordsFound = candidates.length;

        if (supabase && workspaceId && candidates.length) {
          const allTerms = new Set(candidates.map((c) => c.k.keyword.toLowerCase()));
          const scored = candidates
            .filter((c) => assessKeywordQuality(c.k.keyword, allTerms).quality === "ok")
            .map((c) => ({ ...c, r: rel(c.k.keyword) }))
            // Rankings are provenance, not proof of buyer fit or attainability.
            .filter((c) => fit.verdicts.get(c.k.keyword.trim().toLowerCase())?.keep === true)
            // Difficulty had no vote at all in what was stored: the sort was
            // rank, then relevance, then volume. qasimcode.com (authority 0)
            // was given five KD 100 keywords and eight more at KD 70 or worse,
            // and one of the KD 100s was drafted on its first day.
            //
            // Two different judgements, and only the first belongs here.
            //
            // Hopeless is absolute and is dropped: at KD 90+ the top ten are
            // the strongest documents on the web for the phrase, and no
            // authority this product's customers have makes that a plan.
            //
            // Out of reach is relative to this site, and is NOT dropped. A
            // keyword the customer cannot win today is still the market they
            // are in, it is worth seeing on the keywords page, and their
            // authority moves. `recommendKeywords` marks it `skip` with the
            // reason, which is what keeps the unattended writer off it - the
            // same treatment a `suspect` term gets. It only loses the tie-break
            // for the hundred slots, so a reachable term takes the place of an
            // unreachable one of the same relevance.
            //
            // A term the SERP already puts this domain on is exempt from both:
            // the ranking is the measurement and it beats the model.
            .filter((c) => !isHopeless(c.k.difficulty))
            // Source still leads, and that is deliberate: a striking-distance
            // ranking is the cheapest win on the page and must not be crowded
            // out by a merely more on-topic phrase. What made source-first
            // wrong before was the pool, not the sort - "wix" outranked
            // "clinic booking system" because it was in the pool at all. The
            // buyer test above now removes it, so ordering by source is safe.
            .sort(
              (a, b) =>
                b.r - a.r ||
                Number(isOutOfReach(a.k.difficulty, authority)) -
                  Number(isOutOfReach(b.k.difficulty, authority)) ||
                b.k.volume - a.k.volume,
            );
          // Half the list is reserved for terms that can still be written to.
          // Sorted ranked-first, a site with 500 page-one rankings filled all
          // 100 slots with terms `recommendKeywords` then refused to write,
          // and the run ended with an empty month (F2). The surplus page-one
          // rows are deferred, not dropped: they backfill whatever the other
          // sources leave, so a site that ranks for nothing else still stores
          // 100 and the headline number is unchanged for it.
          const alreadyWon = (c: { rank: number; k: DiscoveredKeyword }) => {
            if (c.rank !== 0) return false;
            const position = positionByTerm.get(c.k.keyword.trim().toLowerCase());
            return position !== undefined && position !== null && position <= PAGE_ONE;
          };
          const top = takeReservingSlots(balanceSources(scored, (c) => c.rank), MAX_KEYWORDS_STORED, alreadyWon);
          keywordsFound = top.length;

          const { data: existing } = await supabase
            .from("keywords")
            .select("id, term")
            .eq("workspace_id", workspaceId);
          const seen = new Map(
            (existing ?? []).map((k) => [(k.term as string).toLowerCase(), k.id as string]),
          );

          const rows = top
            .filter((c) => !seen.has(c.k.keyword.toLowerCase()))
            .map((c) => ({
              workspace_id: workspaceId,
              term: c.k.keyword,
              volume: c.k.unmeasured ? null : c.k.volume,
              difficulty: c.k.difficulty,
              cpc: storedCpc(c.k.cpc),
              intent: c.k.intent ?? classifyIntent(c.k.keyword, options.locale ?? "en").intent,
              status: "new",
              // Retain discovery provenance without granting quality exemptions.
              source: c.rank === 0 ? "ranked" : c.rank === 1 ? "gap" : "ideas",
              // The finer provenance the dashboard rolls up: which competitor,
              // or that it came from the profile's own buyer seeds.
              source_type: c.rank === 0 ? "ranked" : c.rank === 1 ? "competitor" : "profile",
              source_ref: c.rank === 1 ? (c.k.competitor ?? null) : null,
              source_url: c.k.sourceUrl ?? null,
              buyer_fit: fit.verdicts.get(c.k.keyword.trim().toLowerCase()) ?? null,
            }));
          if (rows.length) {
            const { data: inserted, error: insertError } = await supabase.from("keywords").insert(rows).select("id, term");
            if (insertError) throw new Error(`Could not store keyword candidates: ${insertError.message}`);
            for (const r of inserted ?? []) seen.set((r.term as string).toLowerCase(), r.id as string);
          }

          // Positions, so the queue can see striking distance. Without this the
          // strongest multiplier in recommendKeywords (a term sitting at 11-20,
          // one revision from page one) could never fire on a new workspace:
          // the ranked data was fetched, shown in a headline, and dropped.
          const positions = ranked
            .filter((k) => k.position !== null)
            .map((k) => ({ id: seen.get(k.keyword.trim().toLowerCase()), position: k.position, url: k.url }))
            .filter((r): r is { id: string; position: number; url: string | null } => Boolean(r.id));
          if (positions.length) {
            await supabase.from("keyword_rankings").insert(
              positions.map((r) => ({
                keyword_id: r.id,
                position: r.position,
                url: r.url,
                checked_at: new Date().toISOString(),
              })),
            );
          }
        }

        const parts = [
          `${fit.verdicts.size}/${toJudge.length} buyer decisions confirmed`,
          toJudge.length > fit.verdicts.size ? `${toJudge.length - fit.verdicts.size} unresolved candidates left out` : "",
          fromRanked.length ? `${fromRanked.length} it already ranks for` : "",
          rankedDropped
            ? `${rankedDropped} on pages that are not yours, left out`
            : "",
          fromCompetitors.length
            ? `${fromCompetitors.length} from what ${discovered.competitorsAsked.length === 1 ? "the competitor" : `the ${discovered.competitorsAsked.length} competitors`} you named rank${discovered.competitorsAsked.length === 1 ? "s" : ""} for`
            : "",
          fromIdeas.length
            ? `${fromIdeas.length} around the ${discovered.seedsPriced} thing${discovered.seedsPriced === 1 ? "" : "s"} you said people buy from you`
            : "",
          refusedByBuyerTest
            ? `${refusedByBuyerTest} dropped as not what your buyers would search`
            : "",
        ].filter(Boolean);
        layers.push({
          id: "keywords",
          status: toJudge.length > 0 && fit.verdicts.size === 0 ? "failed" : "ok",
          detail: `${keywordsFound} keywords found: ${parts.join(", ") || "none"}`,
        });
      })();
    } catch (err) {
      layers.push({
        id: "keywords",
        status: "failed",
        detail: err instanceof Error ? err.message : "keyword discovery failed",
      });
    }
  }

  // --- Authority and traffic ------------------------------------------------
  // Measured above, before the keyword phase, so the reachability filter has a
  // number to judge against on a first run. Reported here, where it always was.
  if (authorityLayer) layers.push(authorityLayer);

  // --- Who links here -------------------------------------------------------
  // Only when there is a workspace to store into; the sales-side "check any
  // domain" path does not need it and should not pay for it.
  if (depth === "full" && hasDataForSeo && supabase && workspaceId) {
    try {
      const r = await syncBacklinks(supabase, workspaceId, domain);
      layers.push({
        id: "backlinks",
        status: "ok",
        detail: r.total !== null ? `${r.total.toLocaleString()} backlinks in the index, ${r.fetched} referring domains stored` : `${r.fetched} referring domains stored`,
      });
    } catch (err) {
      layers.push({ id: "backlinks", status: "failed", detail: err instanceof Error ? err.message : "backlink lookup failed" });
    }
  }

  // --- Headline ------------------------------------------------------------
  // Leads with the readiness gap, because that is what this product sells and
  // it is the finding a prospect has almost certainly never been shown.
  const failingChecks = readiness?.findings.filter((f) => !f.passed).length ?? 0;
  // Rank data goes last in the sentence but is often the part a prospect reacts
  // to, because it is about their own pages rather than their category.
  const close = strikingDistance(ranked);
  const rankNote = close.length
    ? ` ${close.length} keyword${close.length === 1 ? "" : "s"} in striking distance of page one.`
    : ranked.length
      ? ` ${ranked.length} ranking keywords across ${rankedPages} pages.`
      : "";

  const headline = readiness
    ? `Agent readiness ${readiness.score}/100` +
      (failingChecks ? `, ${failingChecks} checks failing` : ", all checks passing") +
      (pagesCrawled ? `. ${issues.length} on-page issues across ${pagesCrawled} pages.` : ".") +
      rankNote
    : pagesCrawled
      ? `${issues.length} on-page issues across ${pagesCrawled} pages.${rankNote}`
      : "Could not analyse this domain from the public web.";

  // A snapshot of this run, from numbers already fetched: no extra provider
  // call, and it turns single columns that get overwritten into a history the
  // workspace page can plot (2026-09-02).
  if (supabase && workspaceId) {
    try {
      await supabase.from("workspace_metrics").upsert(
        {
          workspace_id: workspaceId,
          measured_on: new Date().toISOString().slice(0, 10),
          authority,
          traffic,
          referring_domains: referringDomains,
          ranking_keywords: ranked.length || null,
          readiness: readiness?.score ?? null,
        },
        { onConflict: "workspace_id,measured_on" },
      );
    } catch (err) {
      console.error("[analysis] metric snapshot:", err instanceof Error ? err.message : err);
    }
  }

  const analysis: DomainAnalysis = {
    domain,
    authority,
    traffic,
    platform: detection?.platform ?? null,
    readiness,
    topicalProfile: profile,
    pagesCrawled,
    auditScore,
    issues,
    pagespeed,
    keywordsFound,
    rankedKeywords: ranked,
    strikingDistance: strikingDistance(ranked),
    layers,
    headline,
  };

  // --- Persist -------------------------------------------------------------
  if (supabase && workspaceId) {
    const now = new Date().toISOString();
    await supabase.from("domain_audits").insert({
      workspace_id: workspaceId,
      status: "completed",
      pages_crawled: pagesCrawled,
      // Null stays null: an uncrawlable site has no on-page score, and storing 0
      // would make it indistinguishable from a site that scored badly.
      overall_score: auditScore ?? readiness?.score ?? null,
      issues,
      pagespeed,
      readiness,
      page_facts: homeFacts,
      // NULL when the lookup never ran, [] when it ran and found nothing. A
      // domain nobody could look up is not a domain that ranks for nothing, and
      // the report has to be able to tell those apart.
      ranked_keywords: rankedLayerRan ? ranked : null,
      trigger: "auto_onboarding",
      started_at: now,
      completed_at: now,
    });

    // `first_analysed_at` means "we have looked". A crawl that got nothing for
    // a transient reason is not a look, and stamping it anyway is what made a
    // signup's blip permanent: cron/analyze selects on this column being
    // null, so the stamp was also the decision never to try again. Left null,
    // the next cron slot does the first look properly. A domain that cannot
    // be looked at - no DNS, a bad certificate, an HTTP refusal - is stamped
    // as before, because the answer tomorrow would be the same and the run
    // would buy the same provider calls to hear it.
    //
    // "Left null" is bounded, though: lib/audit/first-look.ts counts the
    // attempts, and a host that times out on every nightly look is stamped
    // after MAX_ANALYSIS_ATTEMPTS rather than retried until somebody reads the
    // cron log. The count comes from the caller (`options.analysisAttempts`):
    // the cron is the only repeated caller and it selects the column; the
    // onboarding run is by definition the first attempt and passes nothing.
    const crawlLayer = layers.find((l) => l.id === "crawl");
    const crawlReason = crawlLayer?.status === "failed" ? crawlLayer.detail : null;
    // A host that rate-banned the crawl before it read a page has not been
    // looked at either: that is a blip on the same terms as a timeout, and
    // the nightly pass, which arrives alone and unhurried, gets a bounded
    // number of further looks (lib/audit/first-look.ts).
    const firstLook = decideFirstLook({
      attemptsBefore: options.analysisAttempts ?? 0,
      pagesCrawled,
      failedForGood:
        crawlReason !== null && !isTransientCrawlFailure(crawlReason) && !(crawlRateLimited && pagesCrawled === 0),
    });

    await supabase
      .from("workspaces")
      .update({
        ...firstLookPatch(firstLook, now),
        // The timestamp on every run, so the editor can tell "we fetched the
        // site and found no CMS we can post to" from "nobody has looked yet";
        // those used to be the same null and got the same "connect a CMS"
        // prompt. The platform itself only on a match: a blank must never
        // replace a platform the user has already confirmed.
        detected_platform_at: now,
        ...(detection ? { detected_platform: detection.platform } : {}),
        // Only overwrite when this run actually produced one, so a later crawl
        // that gets blocked does not erase a good profile.
        ...(profile ? { topical_profile: profile } : {}),
      })
      .eq("id", workspaceId);

    analysis.firstLook = firstLook;
  }

  return analysis;
}
