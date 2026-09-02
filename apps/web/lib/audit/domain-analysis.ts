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
import { runAgentReadiness, type ReadinessResult } from "./agent-readiness";
import { crawlSite, usablePages } from "./crawler";
import { runAuditChecks, calculateAuditScore } from "./checks";
import { fetchPageSpeedDetailed } from "./pagespeed";
import { discoverKeywords, discoverKeywordsFromSeeds } from "@/lib/seo/keywords";
import { profileIsUsable, seedPhrasesFromPages, scoreRelevance } from "@/lib/seo/topical-profile";
import { assessKeywordQuality } from "@/lib/seo/recommendations";
import { hasDataForSEOCredentials } from "@/lib/seo/client";
import {
  fetchRankedKeywords,
  groupByPage,
  strikingDistance,
  type RankedKeyword,
} from "@/lib/seo/ranked-keywords";
import { classifyIntent } from "@/lib/seo/intent";
import { buildTopicalProfile, type TopicalProfile } from "@/lib/seo/topical-profile";
import { detectPlatform, type Detection } from "@/lib/cms/detect";

export interface AnalysisLayer {
  id: "readiness" | "crawl" | "pagespeed" | "platform" | "keywords" | "ranked_keywords";
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
  layers: AnalysisLayer[];
  /** One-line summary for a human skimming the workspace. */
  headline: string;
}

/** Bounded so a first look cannot become an hour-long crawl of a huge site. */
const MAX_PAGES = 40;
const MAX_DEPTH = 2;
const CRAWL_DELAY_MS = 400;
const MAX_KEYWORDS_STORED = 100;

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
export async function analyseDomain(options: {
  domain: string;
  supabase?: SupabaseClient;
  workspaceId?: string;
  locale?: string;
}): Promise<DomainAnalysis> {
  const domain = normalizeDomain(options.domain);
  const { supabase, workspaceId } = options;
  const baseUrl = `https://${domain}`;
  const layers: AnalysisLayer[] = [];

  // --- Agent readiness -----------------------------------------------------
  let readiness: ReadinessResult | null = null;
  try {
    const result = await runAgentReadiness(domain);
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
  let crawledPages: Awaited<ReturnType<typeof crawlSite>> = [];
  let auditScore: number | null = null;
  let issues: unknown[] = [];
  let profile: TopicalProfile | null = null;
  try {
    const fetched = await crawlSite(baseUrl, MAX_PAGES, MAX_DEPTH, CRAWL_DELAY_MS);
    const pages = usablePages(fetched);
    crawledPages = pages;
    pagesCrawled = pages.length;
    if (!pages.length && fetched.length) {
      // Every fetch failed. Say why, and score nothing: the first version of
      // this gave www.lully.ai a 95/100 on-page score and a topical profile of
      // {"www"} from a fetch that never got a response.
      const why = fetched.find((p) => p.error)?.error ?? `HTTP ${fetched[0].status}`;
      layers.push({ id: "crawl", status: "failed", detail: `no page could be fetched: ${why}` });
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
          (auditScore === null ? "not scored" : `score ${auditScore}/100`),
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
  const ps = await fetchPageSpeedDetailed(baseUrl);
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

  // --- Keywords the domain already has some claim to ------------------------
  let keywordsFound = 0;
  const hasDataForSeo = hasDataForSEOCredentials();
  if (!hasDataForSeo) {
    layers.push({
      id: "keywords",
      status: "unavailable",
      detail: "DataForSEO credentials not configured",
    });
  } else {
    try {
      const fromSite = await discoverKeywords(domain, { withDifficulty: true });
      // Seed a second lookup from the site's own vocabulary. For a small site
      // the Ads endpoint returns the category head ("artificial intelligence"
      // for a warehouse-software company); the headings say what it does.
      let seeded: typeof fromSite = [];
      const seeds = profileIsUsable(profile, domain) ? seedPhrasesFromPages(crawledPages, domain) : [];
      if (seeds.length) {
        seeded = await discoverKeywordsFromSeeds(seeds).catch(() => []);
      }
      const seenTerm = new Set(fromSite.map((k) => k.keyword.toLowerCase()));
      // Seeded ideas share a word with the site, which is exactly how another
      // company's brand query gets in ("warehouse 13", "worldfood warehouse").
      // Navigational intent means someone is looking for a specific site, and
      // it is not this one.
      const discovered = [
        ...fromSite,
        ...seeded.filter((k) => !seenTerm.has(k.keyword.toLowerCase()) && k.intent !== "navigational"),
      ];
      keywordsFound = discovered.length;

      if (supabase && workspaceId && discovered.length) {
        // Store what fits the site, not what is biggest. Ranked by raw
        // volume, www.lully.ai's stored set was "uscis case status" and
        // "supreme court"; ranked by relevance to its own vocabulary it is
        // warehouse terms first. With no usable profile, volume is all there is.
        const usable = profileIsUsable(profile, domain);
        const rel = (term: string) => (usable ? scoreRelevance(term, profile).score : 1);
        // Ideas seeded from the site's own headings come first, whatever
        // their relevance number: "warehouse management system" was pushed
        // out of the store by fifty "ai …" terms that each scored a perfect
        // match on one word. Then the rest by relevance, then volume.
        const seededTerms = new Set(seeded.map((k) => k.keyword.toLowerCase()));
        // Provider noise ("ai a ai", "ai and ai", "s eo") is filtered here,
        // at storage, not only in the autonomous queue: a term nobody would
        // type has no business on the keywords page either.
        const allTerms = new Set(discovered.map((k) => k.keyword.toLowerCase()));
        const ranked = [...discovered]
          .filter((k) => assessKeywordQuality(k.keyword, allTerms).quality === "ok")
          .map((k) => ({ k, r: rel(k.keyword), s: seededTerms.has(k.keyword.toLowerCase()) ? 1 : 0 }))
          .filter(({ r }) => !usable || r > 0)
          .sort((a, b) => b.s - a.s || b.r - a.r || b.k.volume - a.k.volume);
        const top = ranked.slice(0, MAX_KEYWORDS_STORED).map(({ k }) => k);

        // Skip terms already tracked, so re-running does not duplicate rows.
        const { data: existing } = await supabase
          .from("keywords")
          .select("term")
          .eq("workspace_id", workspaceId);
        const seen = new Set(
          (existing ?? []).map((k) => (k.term as string).toLowerCase()),
        );

        const rows = top
          .filter((k) => !seen.has(k.keyword.toLowerCase()))
          .map((k) => ({
            workspace_id: workspaceId,
            term: k.keyword,
            volume: k.volume,
            difficulty: k.difficulty,
            intent: k.intent ?? classifyIntent(k.keyword, options.locale ?? "en").intent,
            status: "new",
          }));

        if (rows.length) await supabase.from("keywords").insert(rows);
      }

      layers.push({
        id: "keywords",
        status: "ok",
        detail: seeded.length
          ? `${discovered.length} keywords found: ${fromSite.length} for the domain, ${seeded.length} from what its pages say`
          : `${discovered.length} keywords found for the domain`,
      });
    } catch (err) {
      layers.push({
        id: "keywords",
        status: "failed",
        detail: err instanceof Error ? err.message : "keyword discovery failed",
      });
    }
  }

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
      ranked = await fetchRankedKeywords(domain);
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

  const analysis: DomainAnalysis = {
    domain,
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
      // NULL when the lookup never ran, [] when it ran and found nothing. A
      // domain nobody could look up is not a domain that ranks for nothing, and
      // the report has to be able to tell those apart.
      ranked_keywords: rankedLayerRan ? ranked : null,
      trigger: "auto_onboarding",
      started_at: now,
      completed_at: now,
    });

    await supabase
      .from("workspaces")
      .update({
        first_analysed_at: now,
        // Only when detection actually matched: null means "we could not tell",
        // and overwriting a platform the user has already confirmed with a
        // blank would be worse than never having looked.
        ...(detection
          ? { detected_platform: detection.platform, detected_platform_at: now }
          : {}),
        // Only overwrite when this run actually produced one, so a later crawl
        // that gets blocked does not erase a good profile.
        ...(profile ? { topical_profile: profile } : {}),
      })
      .eq("id", workspaceId);
  }

  return analysis;
}
