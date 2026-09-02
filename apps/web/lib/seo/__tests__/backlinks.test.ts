import { describe, it, expect } from "vitest";
import { parseBacklinkItem, lostBacklinks } from "../backlinks";

describe("backlinks", () => {
  it("scales DataForSEO's 0–1000 rank to a DR-like 0–100 and drops rows without endpoints", () => {
    expect(parseBacklinkItem({ domain_from: "Supalabs.co", domain_from_rank: 339, anchor: "AltoRank", url_to: "https://altorank.co/" }))
      .toEqual({ sourceDomain: "supalabs.co", sourceDr: 34, anchorText: "AltoRank", targetUrl: "https://altorank.co/" });
    expect(parseBacklinkItem({ domain_from: "x.co" })).toBeNull();
    expect(parseBacklinkItem({ domain_from: "x.co", url_to: "https://y/", domain_from_rank: 5000 })!.sourceDr).toBe(100);
  });

  it("marks stored live links that did not come back as lost, and leaves lost ones alone", () => {
    const existing = [
      { source_domain: "a.co", target_url: "https://x/", status: "live" },
      { source_domain: "b.co", target_url: "https://x/", status: "live" },
      { source_domain: "c.co", target_url: "https://x/", status: "lost" },
    ];
    const fetched = [{ sourceDomain: "a.co", sourceDr: 10, anchorText: "", targetUrl: "https://x/" }];
    expect(lostBacklinks(existing, fetched).map((r) => r.source_domain)).toEqual(["b.co"]);
  });
});
