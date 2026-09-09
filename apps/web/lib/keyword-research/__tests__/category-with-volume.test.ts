import { describe, it, expect } from "vitest";
import { categoryCandidates, categoryOf, pickCategory, audienceSeeds, buildPlaybookSeeds } from "../seeds";
import { resolveCategory } from "../category";

/**
 * The category came from the description's first noun pair, which is the
 * company's tagline more often than the market's term. packhub.io: "scan-driven
 * packout". Every seed built on it priced at zero, the profile bought nothing,
 * and the ads fallback filled the pool with Microsoft Teams.
 */
const PACKHUB = {
  description:
    "PackHub is a scan-driven packout solution for fulfillment teams that replaces pre-printed pack slips and shipping labels with an automated workflow. It connects directly to Shopify and other fulfillment systems to validate orders, guide packing, retrieve shipping documents, and automatically update connected systems.",
  audiences: ["Shopify fulfillment teams", "3PL providers"],
  competitors: ["shipstation.com"],
};

/** What the provider actually says about those phrases. */
const PRICES = new Map<string, { volume: number | null }>([
  ["shipping labels", { volume: 27_100 }],
  ["pack slips", { volume: 1_300 }],
  ["fulfillment teams", { volume: null }],
  ["scan-driven packout", { volume: null }],
  ["packout solution", { volume: 0 }],
]);

describe("categoryCandidates", () => {
  it("still leads with the tagline when nothing is priced - categoryOf is unchanged", () => {
    expect(categoryOf(PACKHUB, "packhub")).toBe(categoryCandidates(PACKHUB, "packhub")[0]);
  });

  it("keeps the description's own order, coinage included - volume is what demotes it", () => {
    const c = categoryCandidates(PACKHUB, "packhub");
    expect(c[0]).toBe("scan-driven packout");
    expect(c.length).toBeGreaterThan(3);
  });

  it("includes the phrases the market does search for", () => {
    const c = categoryCandidates(PACKHUB, "packhub");
    expect(c).toContain("shipping labels");
    expect(c).toContain("pack slips");
  });

  it("never offers the brand", () => {
    for (const c of categoryCandidates(PACKHUB, "packhub")) expect(c).not.toContain("packhub");
  });
});

describe("pickCategory — volume decides", () => {
  const c = categoryCandidates(PACKHUB, "packhub");

  it("takes the phrase people actually search over the one the description leads with", () => {
    expect(pickCategory(c, PRICES)).toBe("shipping labels");
  });

  it("ignores a figure below the floor, and an unknown one", () => {
    expect(pickCategory(["packout solution", "fulfillment teams", "pack slips"], PRICES)).toBe("pack slips");
  });

  it("falls back to the first guess when nothing was priced", () => {
    expect(pickCategory(c, new Map())).toBe(c[0]);
  });

  it("returns null for no candidates at all", () => {
    expect(pickCategory([], PRICES)).toBeNull();
  });
});

describe("resolveCategory", () => {
  it("prices the candidates once and reports what it chose", async () => {
    let calls = 0;
    const r = await resolveCategory(PACKHUB, "packhub", { price: async () => { calls += 1; return PRICES; } });
    expect(calls).toBe(1);
    expect(r).toMatchObject({ category: "shipping labels", priced: true, volume: 27_100 });
  });

  it("says so when the market searches none of them, and keeps the first guess", async () => {
    const r = await resolveCategory(PACKHUB, "packhub", { price: async () => new Map() });
    expect(r.priced).toBe(false);
    expect(r.category).toBe(categoryOf(PACKHUB, "packhub"));
  });

  it("survives a provider failure the same way", async () => {
    const r = await resolveCategory(PACKHUB, "packhub", { price: async () => { throw new Error("down"); } });
    expect(r.priced).toBe(false);
    expect(r.category).toBe(categoryOf(PACKHUB, "packhub"));
  });

  it("does nothing without a description", async () => {
    const r = await resolveCategory({ description: "" }, "x", { price: async () => PRICES });
    expect(r).toMatchObject({ category: null, priced: false });
  });
});

describe("the seeds built on a priced category", () => {
  it("audience seeds name the market's term, not the profile's top word", () => {
    const seeds = audienceSeeds(PACKHUB, { topTerms: ["pack", "smarter", "teams"] }, "packhub.io", "shipping labels");
    expect(seeds.map((s) => s.seed)).toEqual(["shopify fulfillment shipping labels", "3pl provider shipping labels"]);
  });

  it("audience seeds still work the old way with no category given", () => {
    const seeds = audienceSeeds(PACKHUB, { topTerms: ["pack", "smarter", "teams"] }, "packhub.io");
    expect(seeds.length).toBeGreaterThan(0);
    expect(seeds[0].seed).toContain("pack");
  });

  it("playbooks take the priced category through the existing override", () => {
    const ctx = { brand: "packhub", category: "shipping labels", profile: PACKHUB };
    expect(buildPlaybookSeeds("use_case", ctx)[0]).toBe("shipping labels for shopify fulfillment teams");
    expect(buildPlaybookSeeds("pricing", ctx)).toContain("how much does shipping labels cost");
  });
});
