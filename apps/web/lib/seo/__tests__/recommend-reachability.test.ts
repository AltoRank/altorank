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

type Row = { id: string; term: string; volume: number; difficulty: number | null };

/** Only the reads `recommendKeywords` makes, in the shapes it makes them. */
function client(rows: Row[], dr: number | null): SupabaseClient {
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
          ? { data: rows.map((r) => ({ ...r, intent: "commercial", status: "new", source: null })) }
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
