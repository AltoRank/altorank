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
import { crawlSite } from "./crawler";
import { runAuditChecks, calculateAuditScore } from "./checks";
import { fetchPageSpeedDetailed } from "./pagespeed";
import { discoverKeywords } from "@/lib/seo/keywords";
import { classifyIntent } from "@/lib/seo/intent";
import { buildTopicalProfile, type TopicalProfile } from "@/lib/seo/topical-profile";

export interface AnalysisLayer {
  id: "readiness" | "crawl" | "pagespeed" | "keywords";
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
  let auditScore: number | null = null;
  let issues: unknown[] = [];
  let profile: TopicalProfile | null = null;
  try {
    const pages = await crawlSite(baseUrl, MAX_PAGES, MAX_DEPTH, CRAWL_DELAY_MS);
    pagesCrawled = pages.length;
    if (pages.length) {
      // Built here because this is the only point that holds the page content.
      // Recommendations need it on every run and must not re-crawl to get it.
      profile = buildTopicalProfile(domain, pages);
      issues = runAuditChecks(pages) as unknown[];
      auditScore = calculateAuditScore(issues as never, pages.length);
      layers.push({
        id: "crawl",
        status: "ok",
        detail: `${pages.length} pages crawled, ${issues.length} issues, score ${auditScore}/100`,
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

  // --- Keywords the domain already has some claim to ------------------------
  let keywordsFound = 0;
  const hasDataForSeo = Boolean(
    process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD,
  );
  if (!hasDataForSeo) {
    layers.push({
      id: "keywords",
      status: "unavailable",
      detail: "DataForSEO credentials not configured",
    });
  } else {
    try {
      const discovered = await discoverKeywords(domain, { withDifficulty: true });
      keywordsFound = discovered.length;

      if (supabase && workspaceId && discovered.length) {
        const top = [...discovered]
          .sort((a, b) => b.volume - a.volume)
          .slice(0, MAX_KEYWORDS_STORED);

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
        detail: `${discovered.length} keywords found for the domain`,
      });
    } catch (err) {
      layers.push({
        id: "keywords",
        status: "failed",
        detail: err instanceof Error ? err.message : "keyword discovery failed",
      });
    }
  }

  // --- Headline ------------------------------------------------------------
  // Leads with the readiness gap, because that is what this product sells and
  // it is the finding a prospect has almost certainly never been shown.
  const failingChecks = readiness?.findings.filter((f) => !f.passed).length ?? 0;
  const headline = readiness
    ? `Agent readiness ${readiness.score}/100` +
      (failingChecks ? `, ${failingChecks} checks failing` : ", all checks passing") +
      (pagesCrawled ? `. ${issues.length} on-page issues across ${pagesCrawled} pages.` : ".")
    : pagesCrawled
      ? `${issues.length} on-page issues across ${pagesCrawled} pages.`
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
      overall_score: auditScore ?? readiness?.score ?? 0,
      issues,
      pagespeed,
      readiness,
      trigger: "auto_onboarding",
      started_at: now,
      completed_at: now,
    });

    await supabase
      .from("workspaces")
      .update({
        first_analysed_at: now,
        // Only overwrite when this run actually produced one, so a later crawl
        // that gets blocked does not erase a good profile.
        ...(profile ? { topical_profile: profile } : {}),
      })
      .eq("id", workspaceId);
  }

  return analysis;
}
