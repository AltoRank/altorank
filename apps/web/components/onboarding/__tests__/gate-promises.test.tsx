import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// What the gate promises, against what the run produced (UX audit
// 2026-10-12, #5 and #8): the site report's line, the setup log's pointers
// to pages a person before their trial cannot open, the brand plug in the
// outline, and the verdict labels on the paywall.

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));

import { preTrialDetail, reportLine } from "../onboarding-progress";
import { TopicBriefs } from "../topic-briefs";
import { isClosingHeading } from "@/lib/onboarding/first-article";
import type { FirstLookReport } from "@/lib/onboarding/first-look-report";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

const report = (over: Partial<FirstLookReport>): FirstLookReport => ({
  auditedAt: "2026-10-12T00:00:00Z",
  pagesCrawled: 40,
  onPageScore: 80,
  readiness: { score: 96, partial: false, error: null, findings: [{ check: "sitemap", passed: false, severity: "high", detail: "", inconclusive: false }] },
  speed: null,
  page: null,
  issues: [],
  existingPages: { checked: 40, withIssues: 25, worst: [] },
  ...over,
});

describe("the site report's line", () => {
  it("leads with what there is to fix, and prints no score beside it", () => {
    const line = reportLine(report({}), "acme-shop.example");
    expect(line).toBe("25 existing pages with something to fix");
    expect(line).not.toMatch(/\/100|readability/i);
  });

  it("calls a site blocked only when its robots.txt turns AI crawlers away, never for advice", () => {
    // The recorded run: 96/100, every AI crawler allowed, and only the
    // optional content-signal directive missing. That is not a blocker.
    const advice = report({
      readiness: {
        score: 96,
        partial: false,
        error: null,
        findings: [
          { check: "ai_crawlers_allowed", passed: true, severity: "high", detail: "all major AI crawlers allowed", inconclusive: false },
          { check: "content_signals", passed: false, severity: "low", detail: "no content-signal directive (optional, emerging)", inconclusive: false },
          { check: "single_h1", passed: false, severity: "low", detail: "2 h1 elements", inconclusive: false },
        ],
      },
    });
    expect(reportLine(advice, "acme-shop.example")).toBe("25 existing pages with something to fix");
    const blocked = report({
      readiness: { score: 60, partial: false, error: null, findings: [{ check: "ai_crawlers_allowed", passed: false, severity: "high", detail: "blocked: GPTBot", inconclusive: false }] },
    });
    expect(reportLine(blocked, "acme-shop.example")).toBe("25 existing pages with something to fix · some AI assistants are blocked from reading it");
    // Unknown is not blocked: robots.txt refused to answer.
    const unknown = report({
      readiness: { score: 60, partial: false, error: null, findings: [{ check: "ai_crawlers_allowed", passed: false, severity: "high", detail: "", inconclusive: true }] },
    });
    expect(reportLine(unknown, "acme-shop.example")).toBe("25 existing pages with something to fix");
  });

  it("names the site when there is nothing to fix", () => {
    expect(reportLine(report({ existingPages: null, readiness: null }), "acme-shop.example")).toBe("acme-shop.example, as we read it");
  });
});

describe("the setup log before the trial", () => {
  it("points nowhere the gate does not open", () => {
    expect(preTrialDetail("Your site could not be read (timeout). Add a keyword by hand from Keywords, or connect Search Console, and the plan can be built from there."))
      .toBe("Your site could not be read (timeout).");
    expect(preTrialDetail("No keyword clear enough to plan yet. 3 searches your buyers make want a landing page rather than an article; see Keywords."))
      .toBe("No keyword clear enough to plan yet. 3 searches your buyers make want a landing page rather than an article.");
    expect(preTrialDetail("Found 81 keywords worth tracking.")).toBe("Found 81 keywords worth tracking.");
    expect(preTrialDetail(undefined)).toBeUndefined();
  });
});

describe("the outline's brand plug", () => {
  it("is recognised in every language the writer closes in, whatever the business is called", () => {
    for (const heading of ["Learn more about Acme Shop", "Scopri di più su Acme", "Más información sobre acme-shop.example", "En savoir plus sur Acme", "Mehr über Acme", "Acme hakkında daha fazla bilgi"]) {
      expect(isClosingHeading(heading), heading).toBe(true);
    }
    for (const heading of ["How to choose a kit", "Learn more about", "What to learn more about first"]) {
      expect(isClosingHeading(heading), heading).toBe(false);
    }
  });
});

describe("why this article, on the paywall", () => {
  it("carries no verdict labels and says who it brings", () => {
    const html = text(renderToStaticMarkup(
      <TopicBriefs
        only="acme kits"
        planned={[{
          term: "acme kits",
          date: "2026-10-12",
          brief: {
            status: "qualified", angle: "A guide", audience: "Hobbyists starting out", buyingJob: "Pick a first kit", offering: "Kits",
            reason: "They search it", evidenceUrls: [], funnel: "audience", confidence: "lower", demand: "unmeasured",
          } as never,
        }]}
      />,
    ));
    expect(html).toContain("Who it brings to your site");
    expect(html).not.toMatch(/Early reader|not yet shopping|Lower confidence|Unmeasured/);
  });
});
