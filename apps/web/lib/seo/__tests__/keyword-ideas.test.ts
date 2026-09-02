import { describe, it, expect } from "vitest";
import { parseKeywordIdea } from "../keywords";
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
