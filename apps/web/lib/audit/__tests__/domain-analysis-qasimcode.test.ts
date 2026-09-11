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
const fit = vi.fn();
const sitemap = vi.fn();
const metrics = vi.fn();

vi.mock("@/lib/e2e/stubs", () => ({ e2eStubsEnabled: () => false, stubAnalyseDomain: vi.fn() }));
vi.mock("../agent-readiness", () => ({ recordingFetcher: () => Object.assign(async () => ({ status: 0, headers: {}, body: "" }), { resources: new Map() }), runAgentReadiness: async () => ({ error: "not run in this test", score: 0, findings: [] }) }));
vi.mock("../pagespeed", () => ({ fetchPageSpeedDetailed: async () => ({ ok: false, kind: "unavailable", detail: "test" }) }));
vi.mock("@/lib/cms/detect", () => ({ detectPlatform: async () => null }));
vi.mock("@/lib/seo/client", () => ({ hasDataForSEOCredentials: () => true }));
vi.mock("@/lib/keyword-research/discovery", () => ({ discoverBuyerKeywords: (...a: unknown[]) => discover(...a) }));
vi.mock("@/lib/keyword-research/buyer-fit", () => ({ judgeBuyerFit: (...a: unknown[]) => fit(...a) }));
vi.mock("@/lib/seo/backlinks", () => ({ syncBacklinks: async () => ({ fetched: 0, total: null, lost: 0 }) }));
vi.mock("@/lib/seo/domain-metrics", () => ({ fetchDomainMetrics: (...a: unknown[]) => metrics(...a) }));
vi.mock("@/lib/seo/site-crawl", () => ({ discoverUrls: (...a: unknown[]) => sitemap(...a) }));

const pages = vi.fn(() => [] as unknown[]);
vi.mock("../crawler", () => ({ crawlSite: async () => pages(), usablePages: (p: unknown[]) => p }));

vi.mock("@/lib/seo/ranked-keywords", async () => {
  const real = await vi.importActual<typeof import("@/lib/seo/ranked-keywords")>("@/lib/seo/ranked-keywords");
  return { ...real, fetchRankedKeywords: (...a: unknown[]) => ranked(...a) };
});

import { analyseDomain } from "../domain-analysis";

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

type Row = { keyword: string; volume: number; difficulty: number | null; cpc: number; competition: number; intent: "info" | "commercial" | "transactional" | "navigational"; competitor?: string };
const asDiscovered = ([keyword, volume, kd]: [string, number, number]): Row => ({
  keyword, volume, difficulty: kd, cpc: 0, competition: 0, intent: "info",
});

const nothingDiscovered = () => ({ fromCompetitors: [], fromIdeas: [], seeds: { seeds: [], basis: "none" as const }, seedsPriced: 0, competitorsAsked: [] });
/** The twenty, as the buyer-seeded ideas source would now hand them over. */
const ideas = (rows: Row[] = THE_TWENTY.map(asDiscovered)) => ({
  ...nothingDiscovered(),
  fromIdeas: rows,
  seeds: { seeds: ["clinic booking website", "salon website with booking"], basis: "model" as const },
  seedsPriced: 2,
});
/** A model verdict: every term kept except the ones named. */
const refusing = (...terms: string[]) => ({
  basis: "model" as const,
  verdicts: new Map(THE_TWENTY.map(([t]) => [t, terms.includes(t) ? { keep: false, reason: "not a buyer search" } : { keep: true, reason: null }])),
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
  for (const m of [ranked, discover, fit, sitemap, metrics]) m.mockReset();
  pages.mockReturnValue(qasimcodePages());
  ranked.mockResolvedValue([]);
  discover.mockResolvedValue(nothingDiscovered());
  fit.mockResolvedValue({ verdicts: new Map(), basis: "none" });
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
    discover.mockImplementation(async () => {
      order.push("discovery");
      return nothingDiscovered();
    });
    await analyse();
    expect(order[0]).toBe("authority");
    expect(order).toContain("discovery");
  });

  it("still reports the authority layer where it always did", async () => {
    const { analysis } = await analyse();
    const ids = analysis.layers.map((l) => l.id);
    expect(ids.indexOf("keywords")).toBeLessThan(ids.indexOf("authority"));
  });

  it("refuses what the buyer test refuses, and stores the rest", async () => {
    discover.mockResolvedValue(ideas());
    fit.mockResolvedValue(refusing("do other countries have states", "other countries", "idea for small businesses"));
    const { stored } = await analyse();
    const terms = stored.map((r) => r.term);
    expect(terms).not.toContain("do other countries have states");
    expect(terms).not.toContain("other countries");
    expect(terms).not.toContain("idea for small businesses");
    expect(terms).toContain("website design");
  });

  it("asks the buyer test about every unproven term, once", async () => {
    discover.mockResolvedValue(ideas());
    await analyse();
    expect(fit).toHaveBeenCalledOnce();
    const asked = fit.mock.calls[0][1] as string[];
    expect(asked).toContain("do other countries have states");
    expect(asked.length).toBeGreaterThan(10);
  });

  it("falls back to the site's own vocabulary when there is no model to ask", async () => {
    // The word-overlap filter that stood alone until 2026-09-11: it still
    // catches the geography term, because nothing on the site says "countries".
    discover.mockResolvedValue(ideas());
    fit.mockResolvedValue({ verdicts: new Map(), basis: "none" });
    const { stored } = await analyse();
    expect(stored.map((r) => r.term)).not.toContain("do other countries have states");
  });

  it("stores none of the five KD 100 terms", async () => {
    discover.mockResolvedValue(ideas());
    const { stored } = await analyse();
    expect(stored.every((r) => (r.difficulty as number) < 90)).toBe(true);
  });

  it("keeps a term it cannot win today, because the market is still the market", async () => {
    // KD 70 at authority 0 is unreachable, and it is also "website design",
    // which is what this business does. It stays on the keywords page;
    // `recommendKeywords` is what refuses to write it.
    discover.mockResolvedValue(ideas());
    const { stored } = await analyse();
    expect(stored.map((r) => r.term)).toContain("website design");
  });

  it("collapses the four ways of saying website design into one", async () => {
    discover.mockResolvedValue(ideas());
    const { stored } = await analyse();
    const designTerms = stored.filter((r) => /website.*design|design.*website/.test(r.term as string));
    expect(designTerms).toHaveLength(2); // "website design" and "website design web"
    // And the two spellings of the same verb.
    expect(stored.filter((r) => /creat/.test(r.term as string))).toHaveLength(0);
  });

  it("turns twenty rows into a handful of distinct queries", async () => {
    discover.mockResolvedValue(ideas());
    const { analysis, stored } = await analyse();
    // The customer-visible count moves, and it moves because the rows it
    // dropped were duplicates, unwinnable, or about geography.
    expect(stored.length).toBeLessThan(THE_TWENTY.length);
    expect(analysis.keywordsFound).toBe(stored.length);
  });

  it("behaves exactly as before for a workspace that never ran the wizard", async () => {
    discover.mockResolvedValue(ideas());
    const { stored } = await analyse(null);
    // No business profile, no subject test, no model verdicts: the geography
    // term is back, and only the dedupe and the hopeless cut have touched it.
    expect(stored.map((r) => r.term)).toContain("do other countries have states");
  });

  it("hands discovery the profile the person confirmed, competitors included", async () => {
    await analyse();
    const arg = discover.mock.calls[0][0] as { domain: string; business: { competitors?: string[]; audiences?: string[] } };
    expect(arg.domain).toBe("qasimcode.com");
    expect(arg.business.competitors).toContain("calendly.com");
    expect(arg.business.audiences).toContain("Medical and dental clinics");
  });

  it("takes the profile the wizard passes in, and reads it when nobody passes one", async () => {
    // #180 wired `options.profile` through the signup. Every other caller -
    // `cron/analyze` re-analysing a workspace nightly - has none in hand and
    // needs the same seeds and the same buyer test.
    const { client } = fakeSupabase(null);
    await analyseDomain({
      domain: "qasimcode.com",
      supabase: client,
      workspaceId: "ws1",
      profile: { ...BUSINESS_PROFILE, name: "Qasimcode", language: "English", country: "Global (English)" },
    });
    const arg = discover.mock.calls[0][0] as { business: { audiences?: string[] } };
    expect(arg.business.audiences).toContain("Medical and dental clinics");
  });

  it("records which rival bought each row", async () => {
    discover.mockResolvedValue({
      ...nothingDiscovered(),
      competitorsAsked: ["calendly.com"],
      fromCompetitors: [{ keyword: "dental clinic website design", volume: 90, difficulty: 12, cpc: 0, competition: 0, intent: "commercial", competitor: "calendly.com" }],
    });
    const { stored } = await analyse();
    const row = stored.find((r) => r.term === "dental clinic website design");
    expect(row?.source).toBe("gap");
    expect(row?.source_type).toBe("competitor");
    expect(row?.source_ref).toBe("calendly.com");
  });

  it("records a buyer-seeded row as the profile's own", async () => {
    discover.mockResolvedValue(ideas([{ keyword: "dental clinic website design", volume: 90, difficulty: 12, cpc: 0, competition: 0, intent: "commercial" }]));
    const { stored } = await analyse();
    const row = stored.find((r) => r.term === "dental clinic website design");
    expect(row?.source).toBe("ideas");
    expect(row?.source_type).toBe("profile");
  });

  it("says on the run screen where the keywords came from and what was refused", async () => {
    discover.mockResolvedValue({
      ...ideas(),
      competitorsAsked: ["calendly.com", "acuityscheduling.com"],
      fromCompetitors: [{ keyword: "salon booking website", volume: 90, difficulty: 12, cpc: 0, competition: 0, intent: "commercial", competitor: "calendly.com" }],
    });
    fit.mockResolvedValue(refusing("do other countries have states", "other countries"));
    const { analysis } = await analyse();
    const detail = analysis.layers.find((l) => l.id === "keywords")?.detail ?? "";
    expect(detail).toContain("1 from what the 2 competitors you named rank for");
    expect(detail).toContain("around 2 searches a buyer makes");
    expect(detail).toContain("2 refused by the buyer test");
  });
});
