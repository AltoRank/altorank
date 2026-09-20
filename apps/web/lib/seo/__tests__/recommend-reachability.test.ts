import { describe, it, expect } from "vitest";
import { recommendKeywords, pickNextKeyword } from "../recommendations";
import { buildTopicalProfile } from "../topical-profile";
import type { CrawlResult } from "@/lib/audit/crawler";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * What the queue does with keywords the site cannot win.
 *
 * qasimcode.com, authority 0. Twelve of its twenty keywords scored exactly 0.0
 * because `1 - relative/100` is exactly 0 for every KD from 45 up, so the
 * twelve were tied and the stable sort left them in the order the provider had
 * returned them. `pickNextKeyword` and `buildPlan` then took whatever was
 * first, and "business building websites" (KD 100) was drafted.
 */

const page = (over: Partial<CrawlResult>): CrawlResult => ({
  url: "https://qasimcode.com/",
  status: 200,
  title: "",
  metaDescription: "",
  h1: [],
  h2: [],
  images: [],
  links: [],
  loadTimeMs: 0,
  ...over,
});

const PROFILE = buildTopicalProfile(
  "qasimcode.com",
  [
    page({
      title: "Appointment websites for clinics and salons | Qasimcode",
      h1: ["Websites that fill the appointment book"],
      h2: ["Website design", "Small business websites"],
    }),
    page({ title: "Business websites", h1: ["Business websites we have built"] }),
  ],
  "2026-09-07T00:00:00.000Z",
);

type Row = { id: string; term: string; volume: number | null; difficulty: number | null; buyer_fit?: unknown; intent?: string };

/** Only the reads `recommendKeywords` makes, in the shapes it makes them. */
function client(
  rows: Row[],
  dr: number | null,
  rankings: Array<{ keyword_id: string; position: number; checked_at: string }> = [],
  pages: Array<{ url: string; keyword: string | null }> = [],
): SupabaseClient {
  const empty = { data: [] as unknown[] };
  const chain = (value: unknown): Record<string, unknown> => {
    const self: Record<string, unknown> = {};
    for (const m of ["eq", "in", "order", "gte", "not", "select"]) {
      self[m] = () => Object.assign(Promise.resolve(value), self);
    }
    self.single = async () => ({
      data: { topical_profile: PROFILE, dr, business_profile: null },
    });
    return self;
  };
  return {
    from(table: string) {
      return chain(
        table === "keywords"
          ? { data: rows.map((r) => ({ intent: "commercial", ...r, status: "new", source: null })) }
          : table === "keyword_rankings"
            ? { data: rankings }
            : table === "site_pages"
              ? { data: pages }
              : empty,
      );
    },
  } as unknown as SupabaseClient;
}

const ROWS: Row[] = [
  { id: "a", term: "business building websites", volume: 2900, difficulty: 100 },
  { id: "b", term: "website design", volume: 49500, difficulty: 70 },
  { id: "c", term: "small business websites", volume: 2400, difficulty: 39 },
  { id: "d", term: "website design account", volume: 1200, difficulty: 28 },
];

describe("recommendKeywords — reachability", () => {
  it("refuses to write what a site at authority 0 cannot rank for", async () => {
    const recs = await recommendKeywords(client(ROWS, 0), "ws1");
    const byTerm = new Map(recs.map((r) => [r.term, r]));
    expect(byTerm.get("business building websites")?.action).toBe("skip");
    expect(byTerm.get("website design")?.action).toBe("skip");
    expect(byTerm.get("website design account")?.action).toBe("write");
  });

  it("says why, in the row the reviewer reads", async () => {
    const recs = await recommendKeywords(client(ROWS, 0), "ws1");
    const kd100 = recs.find((r) => r.term === "business building websites")!;
    expect(kd100.reasons.join(" ")).toContain("out of reach");
  });

  it("keeps the row visible, the way a suspect term is", async () => {
    const recs = await recommendKeywords(client(ROWS, 0), "ws1");
    expect(recs.map((r) => r.term)).toContain("business building websites");
  });

  it("picks the winnable term rather than whatever sorted first", async () => {
    // Before: every KD 45+ row scored 0.0, the twelve were tied, and the pick
    // was the provider's response order.
    const next = pickNextKeyword(await recommendKeywords(client(ROWS, 0), "ws1"));
    expect(next?.term).toBe("website design account");
  });

  it("orders the unwinnable rows among themselves instead of flattening them to zero", async () => {
    const recs = await recommendKeywords(client(ROWS, 0), "ws1");
    const design = recs.find((r) => r.term === "website design")!;
    const kd100 = recs.find((r) => r.term === "business building websites")!;
    // 49,500 searches at KD 70 is a better thing to come back to than 2,900 at
    // KD 100, and the queue should say so even though neither is writable.
    expect(design.score).toBeGreaterThan(kd100.score);
  });

  it("writes the same keyword happily once the site has the authority for it", async () => {
    const recs = await recommendKeywords(client(ROWS, 60), "ws1");
    expect(recs.find((r) => r.term === "website design")?.action).toBe("write");
  });

  it("judges nothing when authority was never measured, except the hopeless", async () => {
    const recs = await recommendKeywords(client(ROWS, null), "ws1");
    expect(recs.find((r) => r.term === "website design")?.action).toBe("write");
    expect(recs.find((r) => r.term === "business building websites")?.action).toBe("skip");
  });
});

describe("recommendKeywords — measured demand", () => {
  // fitsuite.co, 2026-09-19: four of five planned topics were phrases the
  // model proposed and no provider had a single search for.
  const UNMEASURED: Row[] = [
    { id: "m", term: "website design account", volume: 1200, difficulty: 28 },
    { id: "u", term: "small business websites booking", volume: null, difficulty: null },
    { id: "z", term: "business websites appointment", volume: 0, difficulty: null },
  ];

  it("never writes to a term nobody is known to search", async () => {
    const recs = await recommendKeywords(client(UNMEASURED, 0), "ws1");
    const byTerm = new Map(recs.map((r) => [r.term, r]));
    expect(byTerm.get("small business websites booking")?.action).toBe("skip");
    expect(byTerm.get("business websites appointment")?.action).toBe("skip");
    expect(byTerm.get("small business websites booking")?.reasons.join(" ")).toContain("no measured demand");
    expect(byTerm.get("website design account")?.action).toBe("write");
  });

  it("does not pick one even when nothing else is left", async () => {
    const next = pickNextKeyword(await recommendKeywords(client(UNMEASURED.slice(1), 0), "ws1"));
    expect(next).toBeNull();
  });
});

describe("recommendKeywords — audience topics", () => {
  const PAIR: Row[] = [
    { id: "b", term: "website design", volume: 1200, difficulty: 28, buyer_fit: { keep: true, reason: null, funnel: "buyer" } },
    { id: "a", term: "how much do salon owners earn", volume: 1200, difficulty: 28, buyer_fit: { keep: true, reason: null, funnel: "audience" } },
  ];
  it("writes them, labelled, and below the same demand with buying intent", async () => {
    // The buyer term is proven (a position inside the top 20), so neither row
    // is under the vocabulary filter and the only difference is the funnel.
    const recs = await recommendKeywords(client(PAIR, 0, [{ keyword_id: "b", position: 15, checked_at: "2026-09-20T00:00:00Z" }]), "ws1");
    const aud = recs.find((r) => r.term === "how much do salon owners earn")!;
    const buy = recs.find((r) => r.term === "website design")!;
    expect(aud.action).toBe("write");
    expect(aud.funnel).toBe("audience");
    expect(aud.reasons.join(" ")).toContain("top of funnel");
    expect(aud.score).toBeLessThan(buy.score);
    expect(pickNextKeyword(recs)?.term).toBe("website design");
  });
});

describe("recommendKeywords — an audience topic in the audience's words", () => {
  // The site's vocabulary is appointment websites; a salary question shares
  // no word with it and is still what its audience asks.
  const OFF_SITE: Row[] = [
    { id: "s", term: "how much does a salon owner earn", volume: 590, difficulty: 0, buyer_fit: { keep: true, reason: null, funnel: "audience" } },
    { id: "b", term: "website design account", volume: 1200, difficulty: 28, buyer_fit: { keep: true, reason: null, funnel: "buyer" } },
  ];
  it("is not penalised for words the site never uses", async () => {
    const recs = await recommendKeywords(client(OFF_SITE, 0), "ws1");
    const aud = recs.find((r) => r.term === "how much does a salon owner earn")!;
    expect(aud.action).toBe("write");
    expect(aud.reasons.join(" ")).not.toContain("does not appear anywhere on the site");
    // Half a buying topic of the same shape, not a rounding error below it.
    const buy = recs.find((r) => r.term === "website design account")!;
    expect(aud.score).toBeGreaterThan(buy.score * 0.2);
  });
});

describe("recommendKeywords — a navigational label against a buyer verdict", () => {
  // Two phrasings of one search. The bigger one carries the provider's
  // "navigational" label; the buyer test kept both as product searches.
  const PHRASINGS: Row[] = [
    { id: "s", term: "small business websites", volume: 90, difficulty: null, buyer_fit: { keep: true, reason: null, funnel: "buyer" } },
    { id: "g", term: "website design account", volume: 390, difficulty: 6, intent: "navigational", buyer_fit: { keep: true, reason: null, funnel: "buyer" } },
  ];
  it("ranks the phrasing more people search first, and says why the label was set aside", async () => {
    const recs = await recommendKeywords(client(PHRASINGS, 0), "ws1");
    expect(recs[0].term).toBe("website design account");
    expect(recs[0].intent).toBe("commercial");
    expect(recs[0].reasons.join(" ")).toContain("labelled navigational");
  });
  it("keeps the label when no buyer verdict vouches for the term", async () => {
    const recs = await recommendKeywords(client([{ ...PHRASINGS[1], buyer_fit: null }], 0), "ws1");
    expect(recs[0].intent).toBe("navigational");
  });
});

describe("recommendKeywords — a page on the site already targets the query", () => {
  // altorank.co, 2026-09-18: "rankingcoach alternative" was drafted as a blog
  // post while /alternatives/rankingcoach/ sat at position 28 for it.
  const ROWS_: Row[] = [
    { id: "r", term: "rankingcoach alternative", volume: 10, difficulty: 20, buyer_fit: { keep: true, reason: null, funnel: "buyer" } },
    { id: "w", term: "website design account", volume: 1200, difficulty: 28, buyer_fit: { keep: true, reason: null, funnel: "buyer" } },
  ];
  const pages = [{ url: "https://qasimcode.com/alternatives/rankingcoach/", keyword: "rankingcoach alternatives" }];
  it("does not write a second page, and names the one to update", async () => {
    const recs = await recommendKeywords(client(ROWS_, 0, [{ keyword_id: "r", position: 28, checked_at: "2026-09-20T00:00:00Z" }], pages), "ws1");
    const rec = recs.find((r) => r.term === "rankingcoach alternative")!;
    expect(rec.action).toBe("skip");
    expect(rec.existingPageUrl).toBe("https://qasimcode.com/alternatives/rankingcoach/");
    expect(rec.reasons.join(" ")).toContain("/alternatives/rankingcoach/");
    expect(pickNextKeyword(recs)?.term).toBe("website design account");
  });
  it("leaves a term alone when no page targets it", async () => {
    const recs = await recommendKeywords(client(ROWS_, 0, [], []), "ws1");
    expect(recs.find((r) => r.term === "rankingcoach alternative")!.existingPageUrl).toBeNull();
  });
});
