import { describe, expect, it, vi } from "vitest";

const { seeds, rivals, organic, bulk, vet } = vi.hoisted(() => ({ seeds: vi.fn(), rivals: vi.fn(), organic: vi.fn(), bulk: vi.fn(), vet: vi.fn() }));
vi.mock("@/lib/keyword-research/buyer-seeds", () => ({ proposeBuyerSeeds: seeds }));
vi.mock("@/lib/keyword-research/serp-rivals", () => ({ findSerpRivals: rivals, vetRivals: vet }));
vi.mock("@/lib/seo/competitors", async (original) => ({ ...await original<object>(), fetchOrganicCompetitors: organic }));
vi.mock("@/lib/seo/domain-metrics", () => ({ fetchBulkAuthority: bulk }));

import { classifyRivalSize, mergeSuggestions, suggestCompetitors } from "../competitor-suggestions";
import { EMPTY_PROFILE } from "../business-profile";

describe("classifyRivalSize", () => {
  // fitsuite.co at 42 against the hosts its runs met.
  it("needs a margin before calling a host bigger or smaller", () => {
    expect(classifyRivalSize(42, 22)).toBe("smaller");
    expect(classifyRivalSize(42, 28)).toBe("similar");
    expect(classifyRivalSize(42, 59)).toBe("bigger");
    expect(classifyRivalSize(42, 70)).toBe("bigger");
  });
  it("is absent, not a guess, when either side is unmeasured", () => {
    expect(classifyRivalSize(null, 22)).toBeNull();
    expect(classifyRivalSize(42, null)).toBeNull();
  });
});

describe("mergeSuggestions", () => {
  it("keeps one entry per host, first source wins, never the site itself", () => {
    expect(mergeSuggestions("www.fitsuite.co", [
      { source: "site", domains: ["trainerize.com", "https://www.revoo-app.com/pricing"] },
      { source: "serp", domains: ["revoo-app.com", "qomodo.me", "fitsuite.co"] },
      { source: "index", domains: ["qomodo.me", "managify.it"] },
    ])).toEqual([
      { domain: "trainerize.com", source: "site" },
      { domain: "revoo-app.com", source: "site" },
      { domain: "qomodo.me", source: "serp" },
      { domain: "managify.it", source: "index" },
    ]);
  });
});

describe("suggestCompetitors", () => {
  const business = { ...EMPTY_PROFILE, description: "Coaching software for personal trainers", offerings: ["client management"], competitors: ["trainerize.com"] };
  it("tags every suggestion with its source and size, and returns the vetted rivals to keep", async () => {
    seeds.mockResolvedValue({ seeds: ["crm personal trainer", "trainerize pricing"], basis: "model" });
    rivals.mockResolvedValue({ rivals: ["revoo-app.com", "qomodo.me"], searched: [], failed: [], candidates: [], vetted: true });
    organic.mockResolvedValue([
      { domain: "managify.it", sharedKeywords: 4, avgPosition: 12, estimatedTraffic: null },
      // One shared keyword is a coincidence, not a competitor.
      { domain: "aranzulla.it", sharedKeywords: 1, avgPosition: 3, estimatedTraffic: 9_000_000 },
      // Shares enough keywords and is still a magazine: the vetting model says so.
      { domain: "starbene.it", sharedKeywords: 5, avgPosition: 4, estimatedTraffic: 2_000_000 },
    ]);
    vet.mockImplementation(async (candidates: Array<{ host: string }>) => ({ rivals: candidates.map((c) => c.host).filter((h) => h === "managify.it"), vetted: true }));
    bulk.mockResolvedValue(new Map([["fitsuite.co", 42], ["trainerize.com", 70], ["revoo-app.com", 22], ["qomodo.me", 28], ["managify.it", null]]));
    const out = await suggestCompetitors({ domain: "fitsuite.co", business, languageCode: "it", locationCode: 2380 });
    expect(out.own).toBe(42);
    expect(out.searchRivals).toEqual(["revoo-app.com", "qomodo.me"]);
    expect(out.suggestions).toEqual([
      { domain: "trainerize.com", source: "site", authority: 70, size: "bigger" },
      { domain: "revoo-app.com", source: "serp", authority: 22, size: "smaller" },
      { domain: "qomodo.me", source: "serp", authority: 28, size: "similar" },
      { domain: "managify.it", source: "index", authority: null, size: null },
    ]);
    // "trainerize pricing" is an evaluation, not navigation, so it is searched too;
    // the rival search excludes the site and its named rivals.
    expect(rivals.mock.calls[0][0]).toEqual(["crm personal trainer", "trainerize pricing"]);
    expect([...rivals.mock.calls[0][2]]).toEqual(["fitsuite.co", "trainerize.com"]);
  });
  it("still answers with what it has when a source fails", async () => {
    seeds.mockRejectedValue(new Error("no key"));
    organic.mockRejectedValue(new Error("503"));
    vet.mockRejectedValue(new Error("no key"));
    bulk.mockRejectedValue(new Error("503"));
    const out = await suggestCompetitors({ domain: "fitsuite.co", business, languageCode: "it", locationCode: 2380 });
    expect(out).toEqual({ own: null, searchRivals: [], suggestions: [{ domain: "trainerize.com", source: "site", authority: null, size: null }] });
  });
});
