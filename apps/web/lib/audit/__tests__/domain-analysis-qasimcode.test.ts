import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The qasimcode.com signup, 2026-09-07, through `analyseDomain`.
 *
 * A studio that builds appointment-booking websites for clinics, salons,
 * studios and trades. It was given twenty keywords, none of which contains
 * book, appoint, clinic, salon, dental, therap, trade, calendar or schedul;
 * five were KD 100 on a domain the same run measured at authority 0, and the
 * first article written was "Do Other Countries Have States? Full 2026
 * Breakdown".
 *
 * The real keyword set, difficulties and volumes are pinned below, so this
 * fails again the moment any of the four causes comes back.
 */

const ranked = vi.fn();
const discover = vi.fn();
const difficulty = vi.fn();
const seeds = vi.fn();
const gap = vi.fn();
const sitemap = vi.fn();
const metrics = vi.fn();

vi.mock("@/lib/keyword-research/category", () => ({ resolveSeedHead: async () => ({ head: null, priced: false, seedVolume: 0, tried: [] }) }));
vi.mock("@/lib/e2e/stubs", () => ({ e2eStubsEnabled: () => false, stubAnalyseDomain: vi.fn() }));
vi.mock("../agent-readiness", () => ({ recordingFetcher: () => Object.assign(async () => ({ status: 0, headers: {}, body: "" }), { resources: new Map() }), runAgentReadiness: async () => ({ error: "not run in this test", score: 0, findings: [] }) }));
vi.mock("../pagespeed", () => ({ fetchPageSpeedDetailed: async () => ({ ok: false, kind: "unavailable", detail: "test" }) }));
vi.mock("@/lib/cms/detect", () => ({ detectPlatform: async () => null }));
vi.mock("@/lib/seo/client", () => ({ hasDataForSEOCredentials: () => true }));
vi.mock("@/lib/seo/keyword-gap", () => ({ fetchCompetitorGap: (...a: unknown[]) => gap(...a) }));
vi.mock("@/lib/seo/backlinks", () => ({ syncBacklinks: async () => ({ fetched: 0, total: null, lost: 0 }) }));
vi.mock("@/lib/seo/domain-metrics", () => ({ fetchDomainMetrics: (...a: unknown[]) => metrics(...a) }));
vi.mock("@/lib/seo/site-crawl", () => ({ discoverUrls: (...a: unknown[]) => sitemap(...a) }));

const pages = vi.fn(() => [] as unknown[]);
vi.mock("../crawler", () => ({ crawlSite: async () => pages(), usablePages: (p: unknown[]) => p }));

vi.mock("@/lib/seo/ranked-keywords", async () => {
  const real = await vi.importActual<typeof import("@/lib/seo/ranked-keywords")>("@/lib/seo/ranked-keywords");
  return { ...real, fetchRankedKeywords: (...a: unknown[]) => ranked(...a) };
});
vi.mock("@/lib/seo/keywords", async () => {
  const real = await vi.importActual<typeof import("@/lib/seo/keywords")>("@/lib/seo/keywords");
  return {
    ...real,
    discoverKeywords: (...a: unknown[]) => discover(...a),
    fetchKeywordDifficulty: (...a: unknown[]) => difficulty(...a),
    discoverKeywordsFromSeeds: (...a: unknown[]) => seeds(...a),
  };
});

import { analyseDomain, mergeSeeds } from "../domain-analysis";

/** The site as crawled: blog tag pages, plus the page that named the markets. */
function qasimcodePages() {
  const page = (url: string, title: string, h1: string, h2: string[] = []) => ({
    url, status: 200, title, metaDescription: "", h1: [h1], h2, images: [], links: [], loadTimeMs: 10,
  });
  return [
    page("https://qasimcode.com/", "Appointment websites for clinics, salons and studios", "Websites that fill the appointment book", ["Clinics and dental practices", "Salons and beauty studios"]),
    page("https://qasimcode.com/where-we-work", "Where we work", "Clients in other countries", ["The United States", "Danish and Irish clinics"]),
    page("https://qasimcode.com/design", "Website design", "Website design that books appointments", ["Small business websites"]),
    page("https://qasimcode.com/blog", "Business websites", "Business websites, written up", ["Trades and repair", "Beauty studios"]),
  ];
}

const BUSINESS_PROFILE = {
  name: "Qasimcode",
  description:
    "Qasimcode builds appointment-based websites for clinics, salons, studios, and trades, with online booking integrated to existing calendars. Sites are deployed live within two to four weeks at a fixed price agreed upfront.",
  audiences: [
    "Speech therapy practices",
    "Medical and dental clinics",
    "Salons and beauty studios",
    "Trades and service businesses",
  ],
  competitors: ["acuityscheduling.com", "calendly.com", "squarespace.com"],
};

/** Exactly what was stored in production, term by term. */
const THE_TWENTY: Array<[string, number, number]> = [
  ["do other countries have states", 1600, 14],
  ["idea for small businesses", 165000, 32],
  ["ideas on small businesses", 165000, 32],
  ["business ideas for small businesses", 165000, 52],
  ["website company design", 14800, 34],
  ["website design for companies", 14800, 34],
  ["website design firms", 14800, 35],
  ["small business websites", 2400, 39],
  ["other countries", 2900, 51],
  ["best websites builder for small business", 4400, 54],
  ["website about design", 49500, 54],
  ["business websites", 2900, 56],
  ["website design", 49500, 70],
  ["website design web", 49500, 81],
  ["website design websites", 49500, 86],
  ["create business websites", 2900, 100],
  ["creating business websites", 2900, 100],
  ["websites builders for business", 2900, 100],
  ["business websites free", 2900, 100],
  ["business building websites", 2900, 100],
];

const asDiscovered = ([keyword, volume, kd]: [string, number, number]) => ({
  keyword, volume, difficulty: kd, cpc: 0, competition: 0, intent: "info" as const, seed: "website design",
});

function fakeSupabase(business: unknown) {
  const inserted: Array<Record<string, unknown>[]> = [];
  const client = {
    from(table: string) {
      return {
        select: () => ({
          eq: () =>
            Object.assign(Promise.resolve({ data: [] }), {
              single: async () => ({ data: { business_profile: business } }),
            }),
        }),
        insert(rows: Record<string, unknown>[]) {
          if (table === "keywords") inserted.push(rows);
          return {
            select: async () => ({ data: rows.map((r, i) => ({ id: `k${i}`, term: r.term })) }),
            then: (res: (v: { data: null }) => unknown) => res({ data: null }),
          };
        },
        update: () => ({ eq: async () => ({ data: null }) }),
        upsert: async () => ({ data: null }),
      };
    },
  };
  return { client: client as never, inserted };
}

const analyse = (business: unknown = BUSINESS_PROFILE) => {
  const { client, inserted } = fakeSupabase(business);
  return analyseDomain({ domain: "qasimcode.com", supabase: client, workspaceId: "ws1" }).then((a) => ({
    analysis: a,
    stored: inserted.flat(),
  }));
};

beforeEach(() => {
  for (const m of [ranked, discover, difficulty, seeds, gap, sitemap, metrics]) m.mockReset();
  pages.mockReturnValue(qasimcodePages());
  ranked.mockResolvedValue([]);
  seeds.mockResolvedValue([]);
  gap.mockResolvedValue([]);
  discover.mockResolvedValue([]);
  difficulty.mockResolvedValue(new Map());
  sitemap.mockResolvedValue([]);
  // What the run measured for this domain, eleven seconds after storing the
  // keywords it could have judged with it.
  metrics.mockResolvedValue({ authority: 0, traffic: null, referringDomains: null });
});

describe("the qasimcode signup", () => {
  it("measures authority before it decides what to store", async () => {
    // On a first run `workspaces.dr` is null while the keywords are chosen,
    // so no reachability judgement was possible at the moment it mattered.
    const order: string[] = [];
    metrics.mockImplementation(async () => {
      order.push("authority");
      return { authority: 0, traffic: null, referringDomains: null };
    });
    seeds.mockImplementation(async () => {
      order.push("seeds");
      return [];
    });
    await analyse();
    expect(order[0]).toBe("authority");
    expect(order).toContain("seeds");
  });

  it("still reports the authority layer where it always did", async () => {
    const { analysis } = await analyse();
    const ids = analysis.layers.map((l) => l.id);
    expect(ids.indexOf("keywords")).toBeLessThan(ids.indexOf("authority"));
  });

  it("refuses the off-topic keyword that got written, and the seed family it came from", async () => {
    seeds.mockResolvedValue(THE_TWENTY.map(asDiscovered));
    const { stored } = await analyse();
    const terms = stored.map((r) => r.term);
    expect(terms).not.toContain("do other countries have states");
    expect(terms).not.toContain("other countries");
  });

  it("stores none of the five KD 100 terms", async () => {
    seeds.mockResolvedValue(THE_TWENTY.map(asDiscovered));
    const { stored } = await analyse();
    expect(stored.every((r) => (r.difficulty as number) < 90)).toBe(true);
  });

  it("keeps a term it cannot win today, because the market is still the market", async () => {
    // KD 70 at authority 0 is unreachable, and it is also "website design",
    // which is what this business does. It stays on the keywords page;
    // `recommendKeywords` is what refuses to write it.
    seeds.mockResolvedValue(THE_TWENTY.map(asDiscovered));
    const { stored } = await analyse();
    expect(stored.map((r) => r.term)).toContain("website design");
  });

  it("collapses the four ways of saying website design into one", async () => {
    seeds.mockResolvedValue(THE_TWENTY.map(asDiscovered));
    const { stored } = await analyse();
    const designTerms = stored.filter((r) => /website.*design|design.*website/.test(r.term as string));
    expect(designTerms).toHaveLength(2); // "website design" and "website design web"
    // And the two spellings of the same verb.
    expect(stored.filter((r) => /creat/.test(r.term as string))).toHaveLength(0);
  });

  it("turns twenty rows into a handful of distinct queries", async () => {
    seeds.mockResolvedValue(THE_TWENTY.map(asDiscovered));
    const { analysis, stored } = await analyse();
    // The customer-visible count moves, and it moves because the rows it
    // dropped were duplicates, unwinnable, or about geography.
    expect(stored.length).toBeLessThan(THE_TWENTY.length);
    expect(analysis.keywordsFound).toBe(stored.length);
  });

  it("behaves exactly as before for a workspace that never ran the wizard", async () => {
    seeds.mockResolvedValue(THE_TWENTY.map(asDiscovered));
    const { stored } = await analyse(null);
    // No business profile, no subject test: the geography term is back, and
    // only the dedupe and the hopeless cut have touched the list.
    expect(stored.map((r) => r.term)).toContain("do other countries have states");
  });

  it("seeds from the audiences the customer named, within the same call budget", async () => {
    await analyse();
    const seedLists = seeds.mock.calls.map((c) => c[0] as string[]);
    const allSeeds = seedLists.flat();
    // "<audience> <what we sell>". Which noun the category resolves to depends
    // on the crawl; that it is built from the audiences at all is the fix.
    expect(allSeeds.some((s) => s.startsWith("dental clinic "))).toBe(true);
    expect(allSeeds.some((s) => s.startsWith("beauty studio "))).toBe(true);
    expect(allSeeds.some((s) => s.startsWith("therapy practice "))).toBe(true);
    // One call per seed is the spend, and it has not gone up.
    expect(allSeeds.length).toBeLessThanOrEqual(5);
  });

  it("takes the profile the wizard passes in, and reads it when nobody passes one", async () => {
    // #180 wired `options.profile` through the signup. Every other caller -
    // `cron/analyze` re-analysing a workspace nightly - has none in hand and
    // needs the same seeds and the same subject test.
    const { client } = fakeSupabase(null);
    await analyseDomain({
      domain: "qasimcode.com",
      supabase: client,
      workspaceId: "ws1",
      profile: { ...BUSINESS_PROFILE, name: "Qasimcode", language: "English", country: "Global (English)" },
    });
    expect(seeds.mock.calls.flatMap((c) => c[0] as string[]).some((x) => x.startsWith("dental clinic "))).toBe(true);
  });

  it("reserves seed slots for the audiences instead of concatenating them", async () => {
    // `discoverKeywordsFromSeeds` slices to 5. #180 concatenated
    // [...headingSeeds, ...profileSeeds] and the heading seeder returns up to
    // 8, so on any site with readable headings the audience seeds fell off the
    // end of the slice and were never bought at all.
    await analyse();
    const audienceSeedsBought = seeds.mock.calls
      .flatMap((c) => c[0] as string[])
      .filter((x) => /^(dental clinic|beauty studio|therapy practice) /.test(x));
    expect(audienceSeedsBought.length).toBeGreaterThan(0);
  });

  it("buys the audience expansion at a lower volume floor than the page seeds", async () => {
    // The whole point of an audience term is that it is small enough to win.
    await analyse();
    const audienceCall = seeds.mock.calls.find((c) =>
      (c[0] as string[]).some((seed) => seed.startsWith("dental clinic ")),
    );
    expect((audienceCall?.[1] as { minVolume?: number })?.minVolume).toBe(10);
  });

  it("records which audience bought each row", async () => {
    seeds.mockImplementation(async (list: string[]) => {
      const seed = list.find((x) => x.startsWith("dental clinic "));
      return seed
        ? [{ keyword: "dental clinic website design", volume: 90, difficulty: 12, cpc: 0, competition: 0, intent: "commercial", seed }]
        : [];
    });
    const { stored } = await analyse();
    const row = stored.find((r) => r.term === "dental clinic website design");
    expect(row?.source_type).toBe("audience");
    expect(row?.source_ref).toBe("Medical and dental clinics");
  });

  it("says on the run screen that the audiences contributed", async () => {
    seeds.mockImplementation(async (list: string[]) => {
      const seed = list.find((x) => x.startsWith("dental clinic "));
      return seed
        ? [{ keyword: "dental clinic website design", volume: 90, difficulty: 12, cpc: 0, competition: 0, intent: "commercial", seed }]
        : [];
    });
    const { analysis } = await analyse();
    expect(analysis.layers.find((l) => l.id === "keywords")?.detail).toContain(
      "from the audiences you named",
    );
  });
});

describe("mergeSeeds", () => {
  const aud = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ seed: `a${i}`, audience: `A${i}` }));

  it("gives the audiences at most three of the five slots", () => {
    const merged = mergeSeeds(aud(6), ["p0", "p1", "p2", "p3", "p4", "p5"]);
    expect(merged.audience).toHaveLength(3);
    expect(merged.pages).toEqual(["p0", "p1"]);
  });

  it("leaves the whole budget to the pages when there are no audiences", () => {
    const merged = mergeSeeds([], ["p0", "p1", "p2", "p3", "p4", "p5"]);
    expect(merged.audience).toEqual([]);
    expect(merged.pages).toEqual(["p0", "p1", "p2", "p3", "p4"]);
  });

  it("never spends more than the budget", () => {
    const merged = mergeSeeds(aud(6), ["p0", "p1", "p2"], 2);
    expect(merged.audience.length + merged.pages.length).toBe(2);
  });
});
