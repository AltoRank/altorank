import { describe, it, expect } from "vitest";
import { parseKeywordIdea, dedupePermutations } from "../keywords";
import { runAuditChecks } from "@/lib/audit/checks";

describe("parseKeywordIdea", () => {
  it("reads the Labs shape and leaves difficulty null when absent", () => {
    const r = parseKeywordIdea({ keyword: "warehouse orchestration", keyword_info: { search_volume: 720, cpc: 4.2 }, search_intent_info: { main_intent: "commercial" } })!;
    expect(r).toMatchObject({ keyword: "warehouse orchestration", volume: 720, difficulty: null, intent: "commercial" });
    expect(parseKeywordIdea({})).toBeNull();
  });
});

describe("tls_chain audit issue", () => {
  it("reports an unverified chain once for the site", () => {
    const page = { url: "https://x.co/", status: 200, title: "t", metaDescription: "m", h1: ["h"], h2: [], images: [], links: [], loadTimeMs: 100, tlsUnverified: true };
    const issues = runAuditChecks([page, { ...page, url: "https://x.co/a" }]);
    expect(issues.filter((i) => i.type === "tls_chain")).toHaveLength(1);
  });
});

describe("dedupePermutations", () => {
  const k = (keyword: string, volume: number) =>
    ({ keyword, volume, difficulty: 0, cpc: 0, competition: 0, intent: "info" }) as never;

  // The real shape, from one live keyword_suggestions call on "seo content":
  // nine phrasings of one idea, all at 1,300 a month. Each is individually
  // clean, so the per-term quality gate passes every one of them.
  it("keeps one keyword per idea, the best-searched phrasing", () => {
    const out = dedupePermutations([
      k("content marketing and seo", 1300),
      k("seo and content marketing", 1300),
      k("seo marketing content", 1300),
      k("content marketing seo", 1300),
      k("seo content marketing", 1600),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].keyword).toBe("seo content marketing");
  });

  it("breaks a volume tie on the shorter phrasing", () => {
    const out = dedupePermutations([
      k("seo for content marketing", 1300),
      k("seo content marketing", 1300),
    ]);
    expect(out[0].keyword).toBe("seo content marketing");
  });

  it("keeps genuinely different ideas apart", () => {
    const out = dedupePermutations([k("seo content", 900), k("seo audit", 900)]);
    expect(out).toHaveLength(2);
  });
});
