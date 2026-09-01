import { describe, it, expect } from "vitest";
import { renderGrowthPlanEmail, growthPlanSubject } from "../email";
import type { GrowthPlan } from "../build";

const plan: GrowthPlan = {
  domain: "example.com",
  generatedAt: "2026-09-01T20:00:00.000Z",
  rankingKeywords: 40,
  closestWins: [{ keyword: "seo <audit>", position: 12, volume: 1900, path: "/blog/audit" }],
  competitors: [{ domain: "rival.com", sharedKeywords: 50 }],
  gaps: [{ keyword: "broken link building", volume: 170, difficulty: null, rankedBy: [{ domain: "rival.com", position: 2 }] }],
  readiness: {
    score: 70,
    failing: [{ check: "machine_readable", detail: "no llms.txt" }],
    artifacts: [
      { name: "llms.txt", body: "# Example <site>", placement: "Serve at /llms.txt" },
      { name: "sitemap", body: "", placement: "Add a Sitemap: line" },
    ],
  },
  cadence: { articlesPerMonth: 4, firstTargets: ["seo <audit>", "broken link building"], firstPublishDays: 5 },
  layers: [],
};

describe("renderGrowthPlanEmail", () => {
  const html = renderGrowthPlanEmail(plan, "https://app.altorank.co/signup");
  it("escapes everything that came from outside", () => {
    expect(html).not.toContain("<audit>");
    expect(html).toContain("seo &lt;audit&gt;");
    expect(html).toContain("# Example &lt;site&gt;");
  });
  it("carries every block and the generated fix", () => {
    for (const s of ["Closest wins", "/blog/audit", "1,900", "Gaps", "rival.com at #2", "70/100", "llms.txt", "Serve at /llms.txt", "sitemap", "4 articles a month", "signup?domain=example.com"]) {
      expect(html).toContain(s);
    }
  });
  it("has a subject naming the domain", () => {
    expect(growthPlanSubject(plan)).toBe("Growth plan for example.com");
  });
});
