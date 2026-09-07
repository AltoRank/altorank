import { describe, it, expect } from "vitest";
import { describeAssessment, ONBOARDING_CRAWL } from "../site-assessment";
import { isReservedTestDomain } from "@/lib/e2e/stubs";
import type { CrawlSummary } from "@/lib/seo/site-crawl";
import type { TechSummary } from "@/lib/seo/tech-audit";

// The sentence this phase puts on the run screen is the whole of what a
// customer learns about the crawl in the first minute, so it is tested as
// carefully as the crawl. The rule it has to keep: never report a zero for
// something that was not measured. "0 pages checked" on a site with no sitemap
// reads as "your site is empty", which is a different and false claim.

const tech = (over: Partial<TechSummary> = {}): TechSummary => ({
  pages: 12,
  pagesWithIssues: 9,
  findings: 30,
  errors: 1,
  warnings: 20,
  infos: 9,
  byCheck: [],
  ...over,
});

const summary = (over: Partial<CrawlSummary> = {}): CrawlSummary => ({
  discovered: 12,
  fetched: 12,
  failed: 0,
  skipped: 0,
  pages: Array.from({ length: 12 }, (_, i) => ({ url: `https://x.co/${i}` })) as CrawlSummary["pages"],
  tech: tech(),
  disallowed: 0,
  truncated: false,
  robotsBlocked: false,
  ...over,
});

describe("describeAssessment", () => {
  it("says what it read and what it found", () => {
    expect(describeAssessment(summary())).toMatchObject({
      status: "done",
      detail: "Read 12 pages. Found 30 technical issues on 9 of them.",
    });
  });

  it("says so plainly when there was nothing to fix", () => {
    expect(describeAssessment(summary({ tech: tech({ findings: 0, pagesWithIssues: 0 }) })).detail).toBe(
      "Read 12 pages. Nothing technical to fix.",
    );
  });

  it("does not claim an empty site when there was no sitemap", () => {
    const o = describeAssessment(summary({ discovered: 0, fetched: 0, pages: [], tech: tech({ pages: 0, findings: 0 }) }));
    expect(o.status).toBe("skipped");
    expect(o.detail).toBe("No sitemap we could read, so there were no existing pages to check.");
    expect(o.detail).not.toMatch(/\b0\b/);
  });

  it("says when robots.txt is the reason, rather than blaming the site", () => {
    const o = describeAssessment(summary({ robotsBlocked: true, pages: [], fetched: 0 }));
    expect(o.status).toBe("skipped");
    expect(o.detail).toBe("Your robots.txt asks crawlers not to read these pages, so we did not.");
  });

  it("names robots.txt when it kept us out of every page in the sitemap", () => {
    const o = describeAssessment(summary({ pages: [], fetched: 0, disallowed: 12, robotsBlocked: false }));
    expect(o.detail).toBe("Your robots.txt keeps us out of all 12 pages in the sitemap.");
  });

  it("says when the budget ran out before anything was read", () => {
    const o = describeAssessment(summary({ pages: [], fetched: 0, truncated: true }));
    expect(o.detail).toBe("Found pages in the sitemap but ran out of time before reading any.");
  });

  it("says when the pages were there and none of them loaded", () => {
    const o = describeAssessment(
      summary({ fetched: 0, failed: 12, tech: tech({ findings: 12, pagesWithIssues: 12 }) }),
    );
    expect(o.status).toBe("skipped");
    expect(o.detail).toBe("None of the 12 pages we tried would load.");
  });

  /** A partial read must say it is partial, or the count reads as the site. */
  it("admits when it stopped short, and says who picks it up", () => {
    const o = describeAssessment(
      summary({ discovered: 212, pages: Array.from({ length: 40 }, () => ({})) as CrawlSummary["pages"], fetched: 40, truncated: true }),
    );
    expect(o.detail).toContain("Stopped at 40 of 212; the nightly pass reads the rest.");
  });

  it("mentions skipped and failed pages without letting them take over the sentence", () => {
    const o = describeAssessment(summary({ fetched: 10, failed: 2, disallowed: 3 }));
    expect(o.detail).toBe(
      "Read 10 pages. Found 30 technical issues on 9 of them. 3 pages skipped because robots.txt says so. 2 pages did not load.",
    );
  });
});

describe("the onboarding budget", () => {
  /**
   * The worker's ceiling is 300s and `analyseDomain` measured 61s-2.9min on
   * two real runs, so this has to be small enough to leave the rest of the
   * run its room. A number, asserted, because it is the thing that stops a
   * 600-post blog from eating someone's onboarding.
   */
  it("is small enough to sit inside the worker's 300 seconds", () => {
    expect(ONBOARDING_CRAWL.budgetMs).toBeLessThanOrEqual(60_000);
    expect(ONBOARDING_CRAWL.maxPages).toBeLessThanOrEqual(60);
    expect(ONBOARDING_CRAWL.concurrency).toBeLessThanOrEqual(3);
    expect(ONBOARDING_CRAWL.timeoutMs).toBeLessThanOrEqual(15_000);
  });
});

/**
 * The crawl is the one stubbed thing that is free, and the gate is narrow for
 * that reason: the fixture domains do not exist, so they are stubbed; a real
 * domain gets the real crawl even under E2E_STUBS=1. That is what let this
 * phase be exercised against limineer.com and altorank.co with no paid call
 * anywhere in the run.
 */
describe("which domains the crawl is stubbed for", () => {
  it.each(["altorank.test", "e2e.altorank.test", "unreadable.e2e.altorank.test", "https://x.invalid/", "localhost", "app.localhost", "www.example"])(
    "stubs %s, which cannot resolve",
    (domain) => expect(isReservedTestDomain(domain)).toBe(true),
  );

  it.each(["limineer.com", "altorank.co", "https://www.fitsuite.co/blog", "testing.com", "invalid-name.co.uk"])(
    "crawls %s for real",
    (domain) => expect(isReservedTestDomain(domain)).toBe(false),
  );
});
