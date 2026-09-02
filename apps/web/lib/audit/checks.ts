import type { CrawlResult } from "./crawler";
import type { AuditIssue } from "@/lib/types";

/**
 * Run SEO audit checks against crawled pages.
 */
export function runAuditChecks(pages: CrawlResult[]): AuditIssue[] {
  const issues: AuditIssue[] = [];
  // One issue for the site, not one per page: the chain is a server setting.
  const unverified = pages.find((p) => p.tlsUnverified);
  if (unverified) {
    issues.push({
      type: "tls_chain",
      severity: "warning",
      url: unverified.url,
      message: "The TLS certificate chain is incomplete: the server does not send its intermediate certificate",
      details: "Browsers fetch the missing certificate themselves, so visitors see a padlock. Crawlers, AI assistants and many APIs do not, and read the site as unreachable. Install the full chain (leaf + intermediate) on the server or CDN.",
    });
  }
  for (const page of pages) {
    // Broken links (non-2xx status on internal pages)
    if (page.status >= 400 || page.status === 0) {
      issues.push({
        type: "broken_link",
        severity: "error",
        url: page.url,
        message: `Page returned status ${page.status || "timeout/error"}`,
      });
    }

    // Missing meta description
    if (!page.metaDescription && page.status >= 200 && page.status < 400) {
      issues.push({
        type: "missing_meta",
        severity: "warning",
        url: page.url,
        message: "Missing meta description",
      });
    }

    // Missing alt text on images
    for (const img of page.images) {
      if (!img.alt) {
        issues.push({
          type: "missing_alt",
          severity: "warning",
          url: page.url,
          message: `Image missing alt text: ${img.src.slice(0, 80)}`,
          details: img.src,
        });
      }
    }

    // Heading hierarchy
    if (page.h1.length === 0 && page.status >= 200 && page.status < 400) {
      issues.push({
        type: "heading_hierarchy",
        severity: "warning",
        url: page.url,
        message: "Page has no H1 tag",
      });
    }

    if (page.h1.length > 1) {
      issues.push({
        type: "heading_hierarchy",
        severity: "info",
        url: page.url,
        message: `Page has ${page.h1.length} H1 tags (should have 1)`,
      });
    }

    // Slow page
    if (page.loadTimeMs > 3000) {
      issues.push({
        type: "slow_page",
        severity: page.loadTimeMs > 5000 ? "error" : "warning",
        url: page.url,
        message: `Page loaded in ${(page.loadTimeMs / 1000).toFixed(1)}s`,
      });
    }
  }

  // Check for broken outgoing links across all pages
  const allInternalUrls = new Set(pages.map((p) => p.url));
  for (const page of pages) {
    for (const link of page.links) {
      if (link.isInternal && !allInternalUrls.has(link.href)) {
        // This internal link might point to a page that returned an error
        const target = pages.find((p) => p.url === link.href);
        if (target && (target.status >= 400 || target.status === 0)) {
          issues.push({
            type: "broken_link",
            severity: "error",
            url: page.url,
            message: `Broken internal link to ${link.href} (${target.status})`,
            details: `Anchor text: "${link.text}"`,
          });
        }
      }
    }
  }

  return issues;
}

/**
 * Calculate an overall audit score from 0-100.
 */
/**
 * Score an on-page audit, 0-100, or null when nothing was crawled.
 *
 * The old formula multiplied per-page deductions by 10, which saturated the
 * scale almost immediately: supalabs.co returned 418 warnings and 5 errors over
 * 40 pages, giving 861 weighted deductions, (861/40)*10 = 215, and a score of 0.
 * A site had to get under 10 weighted issues per page just to score 1. Stored
 * audits were bimodal as a result - four 0s and one 95 - so the number could not
 * rank two sites or show progress between runs. Without the multiplier the same
 * site scores 78, which is a number somebody can act on.
 *
 * Returns null rather than 0 for an uncrawled site: "we could not read it" and
 * "we read it and it is terrible" are different findings and must not share a
 * number.
 */
export function calculateAuditScore(
  issues: AuditIssue[],
  pagesCrawled: number,
): number | null {
  if (pagesCrawled === 0) return null;

  let deductions = 0;

  for (const issue of issues) {
    switch (issue.severity) {
      case "error":
        deductions += 5;
        break;
      case "warning":
        deductions += 2;
        break;
      case "info":
        deductions += 0.5;
        break;
    }
  }

  // Weighted deductions per page. One error (5) on every page costs 5 points,
  // which is a scale that still discriminates at the bad end.
  const perPage = deductions / pagesCrawled;
  return Math.max(0, Math.round(100 - perPage));
}
