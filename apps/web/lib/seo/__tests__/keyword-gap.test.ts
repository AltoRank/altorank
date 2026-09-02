import { describe, it, expect } from "vitest";
import { rankCompetitors } from "../keyword-gap";

// Captured from a live competitors_domain call on cal.com, 2026-09-02.
// These are the real numbers that made the case for ranking by overlap share
// rather than by shared count.
const calDotComRivals = [
  { domain: "cal.com", metrics: { organic: { count: 5676 } }, full_domain_metrics: { organic: { count: 5676 } } },
  { domain: "zapier.com", metrics: { organic: { count: 1339 } }, full_domain_metrics: { organic: { count: 200318 } } },
  { domain: "calendly.com", metrics: { organic: { count: 1302 } }, full_domain_metrics: { organic: { count: 10913 } } },
  { domain: "apple.com", metrics: { organic: { count: 1252 } }, full_domain_metrics: { organic: { count: 18865792 } } },
  { domain: "microsoft.com", metrics: { organic: { count: 1042 } }, full_domain_metrics: { organic: { count: 2062210 } } },
  { domain: "youcanbook.me", metrics: { organic: { count: 1012 } }, full_domain_metrics: { organic: { count: 11135 } } },
];

describe("rankCompetitors", () => {
  it("keeps real peers and drops the platforms they all share keywords with", () => {
    const out = rankCompetitors(calDotComRivals, "cal.com");
    expect(out.map((c) => c.domain)).toEqual(["calendly.com", "youcanbook.me"]);
  });

  it("ranks by overlap share, not shared count", () => {
    // zapier.com has the HIGHEST shared count (1,339) and is not a peer:
    // 1,339 of its 200,318 keywords is 0.67%. Sorting by count put it first,
    // and cal.com's gap led with "chatgpt" and "copilot".
    const out = rankCompetitors(calDotComRivals, "cal.com");
    expect(out[0].domain).toBe("calendly.com");
    expect(out.find((c) => c.domain === "zapier.com")).toBeUndefined();
  });

  it("excludes the target, which the endpoint always returns", () => {
    expect(rankCompetitors(calDotComRivals, "cal.com").some((c) => c.domain === "cal.com")).toBe(false);
    expect(rankCompetitors(calDotComRivals, "https://www.cal.com").some((c) => c.domain === "cal.com")).toBe(false);
  });

  it("skips a domain whose own total is unknown rather than guessing", () => {
    const out = rankCompetitors(
      [{ domain: "mystery.com", metrics: { organic: { count: 900 } }, full_domain_metrics: null }],
      "cal.com",
    );
    expect(out).toEqual([]);
  });

  it("returns nothing for a site with no comparable competitors", () => {
    // altorank.co's real result: only platforms and itself.
    const out = rankCompetitors(
      [
        { domain: "altorank.co", metrics: { organic: { count: 7 } }, full_domain_metrics: { organic: { count: 7 } } },
        { domain: "youtube.com", metrics: { organic: { count: 7 } }, full_domain_metrics: { organic: { count: 90000000 } } },
      ],
      "altorank.co",
    );
    expect(out).toEqual([]);
  });
});
