import { describe, it, expect } from "vitest";
import { parseCompetitorItem, rankCompetitors } from "../competitors";

// Captured from a live competitors_domain response on 2026-09-01 (target
// outrank.so), trimmed to the fields the parser reads.
const live = {
  domain: "semrush.com",
  avg_position: 13.378197320341048,
  intersections: 1642,
  full_domain_metrics: { organic: { etv: 2827279.2068432793, count: 1000000 } },
};

describe("parseCompetitorItem", () => {
  it("reads the live shape", () => {
    expect(parseCompetitorItem(live)).toEqual({
      domain: "semrush.com",
      sharedKeywords: 1642,
      avgPosition: 13.378197320341048,
      estimatedTraffic: 2827279.2068432793,
    });
  });
  it("tolerates missing fields and drops rows with no domain", () => {
    expect(parseCompetitorItem({ domain: "WWW.A.com" })).toEqual({ domain: "a.com", sharedKeywords: 0, avgPosition: null, estimatedTraffic: null });
    expect(parseCompetitorItem({})).toBeNull();
  });
});

describe("rankCompetitors", () => {
  it("drops the target, generic hosts and zero-overlap rows, most overlap first", () => {
    const c = (domain: string, sharedKeywords: number) => ({ domain, sharedKeywords, avgPosition: null, estimatedTraffic: null });
    const out = rankCompetitors("www.a.com", [c("a.com", 999), c("en.wikipedia.org", 500), c("b.com", 10), c("c.com", 40), c("d.com", 0)], 2);
    expect(out.map((x) => x.domain)).toEqual(["c.com", "b.com"]);
  });
});
