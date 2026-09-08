import { describe, it, expect } from "vitest";
import { recommendKeywords } from "../recommendations";
import { buildTopicalProfile } from "../topical-profile";
import type { CrawlResult } from "@/lib/audit/crawler";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * qasimcode.com, 2026-09-08. A studio selling appointment websites to clinics,
 * salons and trades. After the seeding fix its keyword table held both of the
 * rows below; the picker chose the generic one and the first article written
 * was "Website Design Service in 2026: Compare Your Options".
 *
 * Relevance cannot separate them: every word of both appears on the site, so
 * each scores a flat 1.0. Volume decides, and it is logarithmic - 38.2 against
 * 23.2 - so 6,600 searches of "website design service" beat 210 searches of a
 * term naming the exact buyer the person told us about in the wizard.
 */
const page = (over: Partial<CrawlResult>): CrawlResult => ({
  url: "https://qasimcode.com/", status: 200, title: "", metaDescription: "",
  h1: [], h2: [], images: [], links: [], loadTimeMs: 0, ...over,
});

const PROFILE = buildTopicalProfile(
  "qasimcode.com",
  [
    page({
      title: "Appointment websites for clinics and salons | Qasimcode",
      h1: ["Websites that fill the appointment book"],
      h2: ["Website design service", "Dental clinic websites"],
    }),
    page({ title: "Business websites", h1: ["Website design service"] }),
  ],
  "2026-09-08T00:00:00.000Z",
);

type Row = {
  id: string; term: string; volume: number; difficulty: number | null;
  source_type: string | null; source_ref: string | null;
};

function client(rows: Row[]): SupabaseClient {
  const empty = { data: [] as unknown[] };
  const chain = (value: unknown): Record<string, unknown> => {
    const self: Record<string, unknown> = {};
    for (const m of ["eq", "in", "order", "gte", "not", "select"]) {
      self[m] = () => Object.assign(Promise.resolve(value), self);
    }
    self.single = async () => ({ data: { topical_profile: PROFILE, dr: 0, business_profile: null } });
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

const GENERIC: Row = {
  id: "a", term: "website design service", volume: 6600, difficulty: 0,
  source_type: "profile", source_ref: "profile",
};
const AUDIENCE: Row = {
  id: "b", term: "best dental clinic website", volume: 210, difficulty: 3,
  source_type: "audience", source_ref: "Medical and dental clinics",
};

describe("a confirmed audience outranks raw volume", () => {
  it("puts the term naming the buyer above one thirty times its volume", async () => {
    const recs = await recommendKeywords(client([GENERIC, AUDIENCE]), "ws1");
    expect(recs[0].term).toBe("best dental clinic website");
  });

  it("says why, naming the audience the person gave us", async () => {
    const recs = await recommendKeywords(client([GENERIC, AUDIENCE]), "ws1");
    const top = recs.find((r) => r.term === "best dental clinic website");
    expect(top?.reasons.join(" ")).toContain("Medical and dental clinics");
  });

  it("leaves a term that merely uses the site's words unboosted", async () => {
    const recs = await recommendKeywords(client([GENERIC, AUDIENCE]), "ws1");
    const generic = recs.find((r) => r.term === "website design service");
    expect(generic?.reasons.join(" ")).not.toContain("audience you told us");
  });

  it("does not let the boost rescue a term the site cannot rank for", async () => {
    // The winnability and difficulty rules still apply: a boost multiplies a
    // score, it does not exempt a row from the gates above it.
    const hopeless: Row = { ...AUDIENCE, id: "c", term: "dental websites", difficulty: 95 };
    const recs = await recommendKeywords(client([GENERIC, hopeless]), "ws1");
    expect(recs.find((r) => r.term === "dental websites")?.action).not.toBe("write");
  });
});
