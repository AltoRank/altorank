import { describe, it, expect } from "vitest";
import { groupIssues, reportFromAudit } from "../first-look-report";

const ROW = {
  completed_at: "2026-09-11T10:00:00.000Z",
  started_at: "2026-09-11T09:59:00.000Z",
  pages_crawled: 7,
  overall_score: 78,
  issues: [
    { type: "missing_alt", severity: "warning", url: "https://x.co/", message: "Image missing alt text: /a.png" },
    { type: "missing_alt", severity: "warning", url: "https://x.co/b", message: "Image missing alt text: /b.png" },
    { type: "broken_link", severity: "error", url: "https://x.co/c", message: "Page returned status 404" },
    { type: "heading_hierarchy", severity: "info", url: "https://x.co/", message: "Page has 2 H1 tags (should have 1)" },
    { type: "heading_hierarchy", severity: "warning", url: "https://x.co/d", message: "Page has no H1 tag" },
    "not an issue",
  ],
  pagespeed: {
    performanceScore: 90,
    accessibilityScore: 96,
    bestPracticesScore: null,
    seoScore: 100,
    firstContentfulPaint: 1100,
    largestContentfulPaint: 1140,
    cumulativeLayoutShift: 0.025,
    totalBlockingTime: 0,
    speedIndex: 1900,
  },
  readiness: {
    domain: "x.co",
    score: 83,
    findings: [
      { check: "robots_reachable", passed: true, severity: "high", detail: "200" },
      { check: "machine_readable", passed: false, severity: "medium", detail: "no /llms.txt" },
      { check: "sitemap", passed: false, severity: "high", detail: "robots.txt returned 503", inconclusive: true },
    ],
  },
  page_facts: { status: 200, server: "cloudflare", headings: { h1: 1, h2: 11, h3: 21, h4: 0 } },
};

describe("groupIssues", () => {
  it("folds a list of instances into one line per type, worst first, and keeps an example", () => {
    const groups = groupIssues(ROW.issues);
    expect(groups.map((g) => [g.type, g.severity, g.count])).toEqual([
      ["broken_link", "error", 1],
      ["missing_alt", "warning", 2],
      ["heading_hierarchy", "warning", 2],
    ]);
    expect(groups[1].example).toBe("Image missing alt text: /a.png");
  });

  it("is empty for anything that is not a list", () => {
    expect(groupIssues(null)).toEqual([]);
    expect(groupIssues({})).toEqual([]);
  });
});

describe("reportFromAudit", () => {
  const report = reportFromAudit(ROW, [
    { url: "https://x.co/a", title: "A", tech_issue_count: 0 },
    { url: "https://x.co/b", title: "B", tech_issue_count: 3 },
    { url: "https://x.co/c", title: null, tech_issue_count: 1 },
  ]);

  it("carries the headline numbers", () => {
    expect(report.auditedAt).toBe(ROW.completed_at);
    expect(report.pagesCrawled).toBe(7);
    expect(report.onPageScore).toBe(78);
  });

  it("maps the Lighthouse run, leaving a category it did not score as null rather than zero", () => {
    expect(report.speed).toEqual({
      ok: true,
      strategy: "mobile",
      performance: 90,
      accessibility: 96,
      bestPractices: null,
      seo: 100,
      lcpMs: 1140,
      fcpMs: 1100,
      tbtMs: 0,
      cls: 0.025,
      speedIndexMs: 1900,
    });
  });

  it("keeps a Lighthouse failure as a sentence, not a zero score", () => {
    const r = reportFromAudit({ ...ROW, pagespeed: { unavailable: "PageSpeed rate limit hit" } });
    expect(r.speed).toEqual({ ok: false, detail: "PageSpeed rate limit hit" });
    expect(reportFromAudit({ ...ROW, pagespeed: null }).speed).toBeNull();
    // Rows written before the failure reason was stored.
    expect(reportFromAudit({ ...ROW, pagespeed: {} }).speed).toBeNull();
  });

  it("maps readiness, marking the inconclusive check so the screen does not call it a failure", () => {
    expect(report.readiness?.score).toBe(83);
    expect(report.readiness?.findings.map((f) => [f.check, f.passed, f.inconclusive])).toEqual([
      ["robots_reachable", true, false],
      ["machine_readable", false, false],
      ["sitemap", false, true],
    ]);
  });

  it("passes the homepage facts through and summarises the existing pages, worst first", () => {
    expect(report.page?.server).toBe("cloudflare");
    expect(report.existingPages).toEqual({
      checked: 3,
      withIssues: 2,
      worst: [
        { url: "https://x.co/b", title: "B", techIssueCount: 3 },
        { url: "https://x.co/c", title: null, techIssueCount: 1 },
      ],
    });
  });

  it("is honest about what was never measured", () => {
    const bare = reportFromAudit({ completed_at: null, pages_crawled: null, overall_score: null, issues: null, pagespeed: null, readiness: null });
    expect(bare.readiness).toBeNull();
    expect(bare.speed).toBeNull();
    expect(bare.page).toBeNull();
    expect(bare.issues).toEqual([]);
    expect(bare.existingPages).toBeNull();
    expect(bare.pagesCrawled).toBe(0);
    expect(bare.onPageScore).toBeNull();
  });
});
