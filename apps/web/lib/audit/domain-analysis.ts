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
import { discoverKeywords, discoverKeywordsFromSeeds, type DiscoveredKeyword, storedCpc } from "@/lib/seo/keywords";
import { profileIsUsable, seedPhrasesFromPages, scoreRelevance } from "@/lib/seo/topical-profile";
import { assessKeywordQuality } from "@/lib/seo/recommendations";
import { hasDataForSEOCredentials } from "@/lib/seo/client";
import { dedupePermutations } from "@/lib/seo/keywords";
import { fetchCompetitorGap } from "@/lib/seo/keyword-gap";
import {
  fetchRankedKeywords,
  groupByPage,
  strikingDistance,
  type RankedKeyword,
} from "@/lib/seo/ranked-keywords";
import { classifyIntent } from "@/lib/seo/intent";
import { buildTopicalProfile, type TopicalProfile } from "@/lib/seo/topical-profile";
import { detectPlatform, type Detection } from "@/lib/cms/detect";
import { syncBacklinks } from "@/lib/seo/backlinks";
import { fetchDomainMetrics } from "@/lib/seo/domain-metrics";
import { e2eStubsEnabled, stubAnalyseDomain } from "@/lib/e2e/stubs";

export interface AnalysisLayer {
  id: "readiness" | "crawl" | "pagespeed" | "platform" | "keywords" | "ranked_keywords" | "backlinks" | "authority";
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
}

/** A discovered keyword plus, for a gap row, the rival that holds it. */
type Sourced = DiscoveredKeyword & { competitor?: string };

/** Bounded so a first look cannot become an hour-long crawl of a huge site. */
const MAX_PAGES = 40;
const MAX_DEPTH = 2;
const CRAWL_DELAY_MS = 400;
const MAX_KEYWORDS_STORED = 100;
/** Ceiling on how much of a keyword list may come from keywords_for_site. */
const ADS_FALLBACK_CAP = 40;

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
  /** The workspace's search market, e.g. 2380 for Italy. Paired with `locale`. */
  locationCode?: number;
}): Promise<DomainAnalysis> {
  // E2E_STUBS: fixture keywords, no crawl, no provider, nothing measured (lib/e2e/stubs.ts).
  if (e2eStubsEnabled()) return stubAnalyseDomain(options);
  const domain = normalizeDomain(options.domain);
  const { supabase, workspaceId } = options;
  const depth = options.depth ?? "full";
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
    const fetched = await crawlSite(baseUrl, depth === "quick" ? 1 : MAX_PAGES, depth === "quick" ? 0 : MAX_DEPTH, CRAWL_DELAY_MS);
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
  let keywordsFound = 0;
  if (!hasDataForSeo) {
    layers.push({
      id: "keywords",
      status: "unavailable",
      detail: "DataForSEO credentials not configured",
    });
  } else {
    try {
      const usable = profileIsUsable(profile, domain);
      const rel = (term: string) => (usable ? scoreRelevance(term, profile).score : 1);

      // (1) Ranked terms, best position first.
      const fromRanked: DiscoveredKeyword[] = ranked
        .filter((k) => k.position !== null)
        .map((k) => ({
          keyword: k.keyword,
          volume: k.volume ?? 0,
          difficulty: k.difficulty,
          cpc: k.cpc ?? 0,
          competition: 0,
          intent: classifyIntent(k.keyword, options.locale ?? "en").intent,
        }));

      // (2) Ideas from the site's own headings. A quick run has one page of
      // headings and no budget for a second paid lookup.
      // (1a) What close competitors rank for and we do not. Costs one call to
      // find out there are none, which is the answer for any site without a
      // ranking footprint of its own - so it stops there rather than taking a
      // content plan from whoever happened to share a keyword.
      const gapRows = depth === "full"
        ? await fetchCompetitorGap(domain, { languageCode: options.locale ?? "en" }).catch(() => [])
        : [];
      // The competitor is kept on the row: it becomes the keyword's
      // provenance, which is what lets the dashboard say how many keywords
      // each named rival actually produced.
      const fromGap: Sourced[] = gapRows.map((k) => ({
        keyword: k.keyword,
        volume: k.volume,
        difficulty: k.difficulty,
        cpc: k.cpc,
        competition: 0,
        intent: k.intent,
        competitor: k.competitor,
      }));

      const seeds = usable && depth === "full" ? seedPhrasesFromPages(crawledPages, domain) : [];
      const seeded = seeds.length ? await discoverKeywordsFromSeeds(seeds).catch(() => []) : [];

      const byTerm = new Map<string, { k: Sourced; rank: number }>();
      const add = (k: Sourced, rank: number) => {
        const key = k.keyword.trim().toLowerCase();
        const prev = byTerm.get(key);
        if (!prev || rank < prev.rank) byTerm.set(key, { k, rank });
      };
      for (const k of fromRanked) add(k, 0);
      for (const k of fromGap) if (k.intent !== "navigational") add(k, 1);
      for (const k of seeded) if (k.intent !== "navigational") add(k, 2);

      // (3) The Ads endpoint, only when the first two are thin.
      let usedFallback = false;
      if (depth === "full" && byTerm.size < MAX_KEYWORDS_STORED / 2) {
        const fromSite = await discoverKeywords(domain, { withDifficulty: true }).catch(() => []);
        // Capped, because this is the endpoint that produced every keyword we
        // have ever had to throw away. Making the seeded source stricter made
        // this one fire MORE often - fewer seeded results means the threshold
        // above is met less - and it went from 0 to 71 of altorank.co's 100
        // slots in a single run. A thin list of real keywords beats a full one
        // padded from the source we do not trust.
        const room = Math.max(0, ADS_FALLBACK_CAP - byTerm.size);
        for (const k of fromSite.slice(0, room)) add(k, 3);
        usedFallback = room > 0 && fromSite.length > 0;
      }

      // Collapse phrasings across ALL three sources, not just the seeded one.
      // keyword_suggestions is the worst offender but keywords_for_site emits
      // the same shape: altorank.co came back with "seo for agency", "agency
      // for seo" and "seo agent" as three separate rows at 27,100 each.
      const candidatesAll = [...byTerm.values()];
      const deduped = dedupePermutations(candidatesAll.map((c) => c.k));
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
          // A term the site ranks for is on-topic by definition, whatever the
          // profile says: the SERP already decided.
          .filter((c) => c.rank === 0 || !usable || c.r > 0)
          .sort((a, b) => a.rank - b.rank || b.r - a.r || b.k.volume - a.k.volume);
        const top = scored.slice(0, MAX_KEYWORDS_STORED);
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
            volume: c.k.volume,
            difficulty: c.k.difficulty,
            cpc: storedCpc(c.k.cpc),
            intent: c.k.intent ?? classifyIntent(c.k.keyword, options.locale ?? "en").intent,
            status: "new",
            // The rank is already the provenance: 0 is ranked_keywords, 1 the
            // seeded expansion, 2 the domain-level ads fallback. Recording it
            // keeps the exemption made just above - a ranked term is on-topic
            // because the SERP said so - available to the selector, which
            // otherwise re-applies the filter this row was excused from.
            source:
              c.rank === 0 ? "ranked" : c.rank === 1 ? "gap" : c.rank === 2 ? "ideas" : "ads",
            // The finer provenance the dashboard rolls up: which competitor,
            // or that it came from the site's own pages ("profile").
            source_type:
              c.rank === 0 ? "ranked" : c.rank === 1 ? "competitor" : c.rank === 2 ? "profile" : "ads",
            source_ref: c.rank === 1 ? c.k.competitor ?? null : c.rank === 2 ? "profile" : null,
          }));
        if (rows.length) {
          const { data: inserted } = await supabase.from("keywords").insert(rows).select("id, term");
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
        fromRanked.length ? `${fromRanked.length} it already ranks for` : "",
        seeded.length ? `${seeded.length} from what its pages say` : "",
        usedFallback ? "the rest from the ads keyword tool" : "",
      ].filter(Boolean);
      layers.push({
        id: "keywords",
        status: "ok",
        detail: `${keywordsFound} keywords found: ${parts.join(", ") || "none"}`,
      });
    } catch (err) {
      layers.push({
        id: "keywords",
        status: "failed",
        detail: err instanceof Error ? err.message : "keyword discovery failed",
      });
    }
  }

  // --- Authority and traffic ------------------------------------------------
  // The workspace header reads "Authority —" and "— organic /mo" until these
  // are measured. Only the manual onboarding action ever fetched them, so a
  // workspace analysed by the cron never had either (2026-09-02). Nulls stay
  // null: an unmeasured number is not a zero.
  let authority: number | null = null;
  let traffic: number | null = null;
  let referringDomains: number | null = null;
  if (hasDataForSeo) {
    try {
      // Location travels with language or the pair is rejected. This passed
      // the workspace's language and let the location default to the United
      // States, so an Italian site asked for Italian results in the US and
      // DataForSEO answered "Invalid Field: 'language_code'" - which reads
      // like the field is wrong rather than the combination. Traffic was
      // therefore null on every non-English workspace (2026-09-04).
      const m = await fetchDomainMetrics(domain, {
        languageCode: options.locale ?? "en",
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
      layers.push({
        id: "authority",
        status: m.authority === null && m.traffic === null ? "unavailable" : "ok",
        detail:
          m.authority === null && m.traffic === null
            ? "no authority or traffic estimate returned for this domain"
            : `authority ${m.authority ?? "—"}, ${m.traffic?.toLocaleString() ?? "—"} organic visits a month`,
      });
    } catch (err) {
      layers.push({ id: "authority", status: "failed", detail: err instanceof Error ? err.message : "authority lookup failed" });
    }
  }

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
  }

  return analysis;
}
