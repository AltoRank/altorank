import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Candidate hygiene, free and before any judge: a general site read as a
 * rival is dropped with every row it brought, and a rival phrase with no
 * word of the business is dropped alone. Discovery runs for real; only the
 * paid edges are faked.
 */

const ranked = vi.fn();
const price = vi.fn();
const suggest = vi.fn();
const ask = vi.fn();
vi.mock("@/lib/seo/ranked-keywords", () => ({ fetchRankedKeywords: (...a: unknown[]) => ranked(...a) }));
vi.mock("../metrics", () => ({ fetchTermMetrics: (...a: unknown[]) => price(...a) }));
vi.mock("@/lib/seo/keywords", async () => {
  const real = await vi.importActual<typeof import("@/lib/seo/keywords")>("@/lib/seo/keywords");
  return { ...real, discoverKeywordsFromSeeds: (...a: unknown[]) => suggest(...a) };
});
vi.mock("../buyer-model", async () => {
  const real = await vi.importActual<typeof import("../buyer-model")>("../buyer-model");
  return { ...real, modelAvailable: () => true, askStructured: (...a: unknown[]) => ask(...a) };
});

import { discoverBuyerKeywords } from "../discovery";
import { isGeneralPool, isGeneralSite, profileVocabulary, sharesVocabulary } from "../hygiene";
import { describeFunnel, funnelDiscrepancy, withScreened } from "../topic-funnel";

const GARAGE = {
  name: "Northside Garage",
  description: "Northside Garage repairs cars: brakes, tyres, suspension and servicing.",
  audiences: ["car owners"],
  offerings: ["brake repair", "tyre fitting", "car servicing"],
  competitors: ["rivalgarage.test", "microsoft.com"],
};
const rankedRow = (keyword: string) => ({ keyword, position: 4, url: null, volume: 500, difficulty: 30, cpc: 1, isBlogUrl: false });

beforeEach(() => {
  for (const m of [ranked, price, suggest, ask]) m.mockReset();
  price.mockResolvedValue(new Map());
  suggest.mockResolvedValue([]);
  ask.mockResolvedValue('["brake pad replacement"]');
});

describe("the vocabulary a rival phrase is held to", () => {
  const vocab = profileVocabulary(GARAGE, ["fren balata değişimi"]);
  it("matches a word on its stem, in the profile's language and the seeds'", () => {
    expect(sharesVocabulary("brakes squeaking", vocab)).toBe(true);
    expect(sharesVocabulary("tyres near me", vocab)).toBe(true);
    expect(sharesVocabulary("fren balatası fiyatları", vocab)).toBe(true);
    expect(sharesVocabulary("online games", vocab)).toBe(false);
    // Function words carry no subject.
    expect(sharesVocabulary("best free online", vocab)).toBe(false);
  });
  it("reads a pool that is mostly off-profile as a general site's", () => {
    const junk = ["online games", "webmail login", "translate", "streaming films", "puzzle games", "photo editor", "weather today", "music player", "brake repair", "tyre fitting"];
    expect(isGeneralPool(junk, vocab)).toBe(true);
    expect(isGeneralPool(junk.slice(0, 6), vocab)).toBe(false); // too few rows to read a pattern
    expect(isGeneralSite("www.microsoft.com")).toBe(true);
    expect(isGeneralSite("rivalgarage.test")).toBe(false);
  });
});

describe("discovery with hygiene", () => {
  it("never reads a listed platform, drops a general pool whole and an off-profile row alone, and counts both", async () => {
    ranked.mockImplementation(async (host: string) => host === "rivalgarage.test"
      ? [rankedRow("brake repair cost"), rankedRow("rivalgarage pricing"), rankedRow("football scores")]
      : []);
    const out = await discoverBuyerKeywords({ domain: "northside.test", business: { ...GARAGE, searchRivals: ["bigportal.test"] } });
    // microsoft.com is on the list: not read at all.
    expect(ranked.mock.calls.map((c) => c[0])).not.toContain("microsoft.com");
    expect(out.fromCompetitors.map((k) => k.keyword)).toEqual(["brake repair cost", "rivalgarage pricing"]);
    expect(out.screened).toMatchObject({ offProfile: 1, generalRival: 0 });
    expect(out.screened.generalRivals).toContain("microsoft.com");
  });
  it("drops every row of a kept search rival whose pool is the internet, and does not keep it as a rival", async () => {
    const junk = ["online games", "webmail login", "translate text", "streaming films", "puzzle games", "photo editor", "weather today", "music player", "sports news", "car servicing"];
    ranked.mockImplementation(async (host: string) => host === "bigportal.test" ? junk.map(rankedRow) : []);
    const out = await discoverBuyerKeywords({ domain: "northside.test", business: { ...GARAGE, competitors: [], searchRivals: ["bigportal.test"] } });
    expect(out.fromCompetitors).toHaveLength(0);
    expect(out.screened).toMatchObject({ generalRival: 10, offProfile: 0, generalRivals: ["bigportal.test"] });
    expect(out.serpRivals).not.toContain("bigportal.test");
    expect(out.serpRivalsKept).toBe(false);
  });
});

describe("the funnel counts what hygiene dropped", () => {
  it("adds the dropped to what was found, each at its own stage, and still adds up", () => {
    const f = withScreened({ found: 10, removed: { buyer_fit: 8 }, qualified: 2 }, { generalRival: 30, offProfile: 5 })!;
    expect(f).toMatchObject({ found: 45, removed: { general_rival: 30, off_profile: 5, buyer_fit: 8 }, qualified: 2 });
    expect(funnelDiscrepancy(f)).toBeNull();
    expect(describeFunnel(f)).toBe("45 found: 30 general rival, 5 off profile, 8 buyer fit -> 2 qualified");
    expect(withScreened(null, { generalRival: 3, offProfile: 0 })).toMatchObject({ found: 3, qualified: 0 });
    expect(withScreened(null, { generalRival: 0, offProfile: 0 })).toBeNull();
  });
});
