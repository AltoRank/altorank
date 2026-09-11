import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The buyer-side research that replaced heading seeds, the competitor gap and
 * the Ads fallback on 2026-09-11: what the model calls parse, how the two
 * sources merge, and what a brand term looks like.
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

import { parseSeeds, seedsFromProfile, proposeBuyerSeeds } from "../buyer-seeds";
import { parseVerdicts, judgeBuyerFit, MAX_JUDGED } from "../buyer-fit";
import { discoverBuyerKeywords, isBrandTerm, MAX_EXPANDED_SEEDS } from "../discovery";

const PACKHUB = {
  name: "PackHub",
  description: "PackHub is an order picking and packing app for Shopify merchants: pack slips, barcode scanning, and shipping labels from one screen.",
  audiences: ["Shopify merchants fulfilling in-house", "Small 3PL warehouses"],
  offerings: ["order picking software", "packing slip generator", "shopify barcode scanning"],
  competitors: ["packiyo.com", "shipstation.com", "www.easyship.com"],
};

beforeEach(() => {
  for (const m of [ranked, price, suggest, ask]) m.mockReset();
  ranked.mockResolvedValue([]);
  price.mockResolvedValue(new Map());
  suggest.mockResolvedValue([]);
  ask.mockResolvedValue(null);
});

describe("parseSeeds", () => {
  it("takes a bare JSON array, lower-cased, deduplicated, two words or more", () => {
    const raw = 'Here you go:\n["Packing Slip Template", "packing slip template", "shipping", "order picking software"]';
    expect(parseSeeds(raw)).toEqual(["packing slip template", "order picking software"]);
  });

  it("is empty for prose, a fence with nothing in it, or null", () => {
    expect(parseSeeds("I cannot help with that.")).toEqual([]);
    expect(parseSeeds("```json\n[]\n```")).toEqual([]);
    expect(parseSeeds(null)).toEqual([]);
  });

  it("stops at fifteen", () => {
    const many = JSON.stringify(Array.from({ length: 30 }, (_, i) => `seed phrase ${i}`));
    expect(parseSeeds(many)).toHaveLength(15);
  });
});

describe("seedsFromProfile", () => {
  it("uses the offerings and audiences as typed when there is no model", () => {
    expect(seedsFromProfile(PACKHUB)).toEqual([
      "order picking software",
      "packing slip generator",
      "shopify barcode scanning",
      "shopify merchants fulfilling in-house",
      "small 3pl warehouses",
    ]);
  });
  it("is empty for no profile", () => {
    expect(seedsFromProfile(null)).toEqual([]);
  });
});

describe("proposeBuyerSeeds", () => {
  it("asks the model with the whole profile and says so", async () => {
    ask.mockResolvedValue('["packing slip template", "order picking app"]');
    const out = await proposeBuyerSeeds(PACKHUB);
    expect(out).toEqual({ seeds: ["packing slip template", "order picking app"], basis: "model" });
    const prompt = ask.mock.calls[0][1] as string;
    expect(prompt).toContain("What people buy from it: order picking software");
    expect(prompt).toContain("Competitors: packiyo.com");
  });

  it("falls back to the profile's own words when the model answers nothing usable", async () => {
    ask.mockResolvedValue("no");
    const out = await proposeBuyerSeeds(PACKHUB);
    expect(out.basis).toBe("profile");
    expect(out.seeds).toContain("order picking software");
  });

  it("has nothing to say for an empty profile", async () => {
    expect(await proposeBuyerSeeds({ name: "x" })).toEqual({ seeds: [], basis: "none" });
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("parseVerdicts", () => {
  const asked = ["packing slip template", "ups shipping calculator", "shipping"];

  it("folds the reply onto the terms asked, case-insensitively, with a reason for every refusal", () => {
    const raw = JSON.stringify([
      { t: "Packing Slip Template", k: true, r: "" },
      { t: "ups shipping calculator", k: false, r: "consumer postage lookup" },
      { t: "shipping", k: false },
      { t: "not asked", k: true },
    ]);
    const v = parseVerdicts(raw, asked);
    expect(v.get("packing slip template")).toEqual({ keep: true, reason: null });
    expect(v.get("ups shipping calculator")).toEqual({ keep: false, reason: "consumer postage lookup" });
    expect(v.get("shipping")?.keep).toBe(false);
    expect(v.get("shipping")?.reason).toBeTruthy();
    expect(v.has("not asked")).toBe(false);
  });

  it("ignores a malformed entry rather than failing the batch", () => {
    const raw = '[{"t":"shipping","k":"yes"},{"t":"packing slip template","k":true}]';
    const v = parseVerdicts(raw, asked);
    expect(v.size).toBe(1);
  });
});

describe("judgeBuyerFit", () => {
  it("asks once, about at most MAX_JUDGED distinct terms, with the profile", async () => {
    ask.mockResolvedValue('[{"t":"term 1","k":true}]');
    const terms = Array.from({ length: MAX_JUDGED + 40 }, (_, i) => `term ${i}`);
    const out = await judgeBuyerFit(PACKHUB, [...terms, "term 1"]);
    expect(ask).toHaveBeenCalledOnce();
    const prompt = ask.mock.calls[0][1] as string;
    expect(JSON.parse(prompt.slice(prompt.indexOf("PHRASES") + 8))).toHaveLength(MAX_JUDGED);
    expect(out.basis).toBe("model");
  });

  it("has no verdicts without a profile to judge against", async () => {
    const out = await judgeBuyerFit(null, ["a b"]);
    expect(out).toEqual({ verdicts: new Map(), basis: "none" });
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("isBrandTerm", () => {
  it("catches our name and every rival's, and leaves the category alone", () => {
    const rivals = ["packiyo.com", "shipstation.com", "easyship.com"];
    expect(isBrandTerm("packiyo pricing", "packhub.io", rivals)).toBe(true);
    expect(isBrandTerm("shipstation vs easyship", "packhub.io", rivals)).toBe(true);
    expect(isBrandTerm("packhub reviews", "packhub.io", rivals)).toBe(true);
    expect(isBrandTerm("packing slip template", "packhub.io", rivals)).toBe(false);
    expect(isBrandTerm("ship station alternatives", "packhub.io", rivals)).toBe(true);
  });
});

describe("discoverBuyerKeywords", () => {
  const rankedRow = (keyword: string, volume = 500) => ({ keyword, position: 4, url: null, volume, difficulty: 30, cpc: 1, isBlogUrl: false });

  it("reads what the rivals the person named rank for, three at most, never itself", async () => {
    ranked.mockResolvedValue([rankedRow("packing slip template"), rankedRow("packiyo login"), rankedRow("shipstation pricing")]);
    ask.mockResolvedValue('["packing slip template"]');
    const out = await discoverBuyerKeywords({
      domain: "packhub.io",
      business: { ...PACKHUB, competitors: ["packhub.io", "packiyo.com", "shipstation.com", "easyship.com", "shippo.com"] },
    });
    expect(out.competitorsAsked).toEqual(["packiyo.com", "shipstation.com", "easyship.com"]);
    expect(ranked).toHaveBeenCalledTimes(3);
    expect(ranked.mock.calls[0][1]).toMatchObject({ limit: 100, minVolume: 100, maxRank: 20 });
    // One row survives per rival call: the two brand rows are dropped.
    expect(out.fromCompetitors.map((k) => k.keyword)).toEqual(["packing slip template"]);
    expect(out.fromCompetitors[0].competitor).toBe("packiyo.com");
  });

  it("prices the seeds, keeps the ones anyone searches, and long-tails the best five", async () => {
    ask.mockResolvedValue(JSON.stringify(["packing slip template", "order picking software", "warehouse picking app", "packiyo alternative", "a b", "c d", "e f", "g h"]));
    price.mockResolvedValue(
      new Map([
        ["packing slip template", { term: "packing slip template", volume: 1300, difficulty: null, cpc: 3.1, intent: "info" }],
        ["order picking software", { term: "order picking software", volume: 50, difficulty: null, cpc: 46.7, intent: "commercial" }],
        ["warehouse picking app", { term: "warehouse picking app", volume: 0, difficulty: 39, cpc: null, intent: "navigational" }],
        ["packiyo alternative", { term: "packiyo alternative", volume: 200, difficulty: 5, cpc: 1, intent: "commercial" }],
        ["a b", { term: "a b", volume: 40, difficulty: 1, cpc: 0, intent: "info" }],
        ["c d", { term: "c d", volume: 30, difficulty: 1, cpc: 0, intent: "info" }],
        ["e f", { term: "e f", volume: 20, difficulty: 1, cpc: 0, intent: "info" }],
        ["g h", { term: "g h", volume: 15, difficulty: 1, cpc: 0, intent: "info" }],
      ]),
    );
    suggest.mockResolvedValue([
      { keyword: "shopify packing slip template", volume: 140, difficulty: 7, cpc: 0, competition: 0, intent: "info", seed: "packing slip template" },
      { keyword: "packing slip template", volume: 1300, difficulty: 0, cpc: 0, competition: 0, intent: "info", seed: "packing slip template" },
      { keyword: "easyship packing slip", volume: 90, difficulty: 0, cpc: 0, competition: 0, intent: "info", seed: "packing slip template" },
    ]);
    const out = await discoverBuyerKeywords({ domain: "packhub.io", business: PACKHUB, languageCode: "en" });
    expect(price).toHaveBeenCalledOnce();
    expect(out.seedsPriced).toBe(6); // the zero-volume seed and the rival's name are out
    // Best-priced first, at most five, into one suggestions call.
    const expanded = suggest.mock.calls[0][0] as string[];
    expect(expanded).toHaveLength(MAX_EXPANDED_SEEDS);
    expect(expanded[0]).toBe("packing slip template");
    expect(expanded).not.toContain("warehouse picking app");
    const terms = out.fromIdeas.map((k) => k.keyword);
    expect(terms[0]).toBe("packing slip template");
    expect(terms).toContain("order picking software");
    expect(terms).toContain("shopify packing slip template");
    expect(terms).not.toContain("packiyo alternative");
    expect(terms).not.toContain("easyship packing slip");
    expect(terms.filter((t) => t === "packing slip template")).toHaveLength(1);
    expect(out.seeds.basis).toBe("model");
  });

  it("prices nothing and expands nothing when there are no seeds", async () => {
    const out = await discoverBuyerKeywords({ domain: "x.co", business: null });
    expect(price).not.toHaveBeenCalled();
    expect(suggest).not.toHaveBeenCalled();
    expect(out.seeds).toEqual({ seeds: [], basis: "none" });
    expect(out.seedsPriced).toBe(0);
  });

  it("does not long-tail a seed nobody searches", async () => {
    ask.mockResolvedValue('["warehouse picking app"]');
    price.mockResolvedValue(new Map([["warehouse picking app", { term: "warehouse picking app", volume: 0, difficulty: 39, cpc: null, intent: "info" }]]));
    const out = await discoverBuyerKeywords({ domain: "x.co", business: PACKHUB });
    expect(suggest).not.toHaveBeenCalled();
    expect(out.fromIdeas).toEqual([]);
  });

  it("survives a rival lookup that throws", async () => {
    ranked.mockRejectedValue(new Error("40501"));
    const out = await discoverBuyerKeywords({ domain: "x.co", business: { competitors: ["rival.co"] } });
    expect(out.fromCompetitors).toEqual([]);
  });
});
