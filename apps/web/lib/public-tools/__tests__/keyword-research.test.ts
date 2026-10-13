import { describe, it, expect, vi, beforeEach } from "vitest";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/seo/client", () => ({
  post,
  hasDataForSEOCredentials: () => true,
  DataForSEOError: class DataForSEOError extends Error {},
}));
vi.mock("@/lib/billing/default-spend", () => ({ recordSpendByDefault: vi.fn(), spendClient: () => null }));

import { dfs, ctx, quiet, issue, kvOf, tableOf, textOf, item } from "./paid-helpers";
import { keywordResearch as tool } from "../tools/keyword-research";

beforeEach(() => {
  post.mockReset();
});
const endpoints = () => post.mock.calls.map((c) => c[0] as string);
const taskOf = (endpoint: string) => (post.mock.calls.find((c) => c[0] === endpoint)![1] as Array<Record<string, unknown>>)[0];

const kw = (keyword: string, volume: number | null, kd: number | null = 10, cpc: number | null = 1.5, intent = "commercial") => ({
  keyword,
  keyword_info: { search_volume: volume, cpc, search_volume_trend: { yearly: 12 } },
  keyword_properties: { keyword_difficulty: kd },
  search_intent_info: { main_intent: intent },
});

describe("keyword-research", () => {
  it("shows the seed and merges suggestions with related searches, by volume", async () => {
    post.mockImplementation(async (endpoint: string) =>
      endpoint.includes("keyword_suggestions")
        ? dfs({ seed_keyword_data: kw("crm for agencies", 1000, 0, 49.64), items: [kw("crm for agencies", 1000), kw("best crm for agencies", 70), kw("crm for travel agencies", null, null, null)] })
        : dfs({ items: [{ depth: 0, keyword_data: kw("crm for agencies", 1000) }, { depth: 1, keyword_data: kw("agency crm", 390) }, { depth: 1, keyword_data: kw("Best CRM for agencies", 70) }] }),
    );
    const blocks = await tool.run(tool.input.parse({ keyword: "CRM for agencies", country: "gb" }), ctx());

    expect(taskOf("/dataforseo_labs/google/keyword_suggestions/live")).toMatchObject({ keyword: "crm for agencies", location_code: 2826, language_code: "en", include_seed_keyword: true, limit: 50 });
    expect(taskOf("/dataforseo_labs/google/related_keywords/live")).toMatchObject({ depth: 1, location_code: 2826 });

    const seed = kvOf(blocks);
    expect(seed.title).toBe('"CRM for agencies" in United Kingdom');
    expect(item(seed, "Monthly searches")?.value).toMatch(/^1,000/);
    expect(item(seed, "Cost per click")?.value).toBe("$49.64 (USD)");
    expect(item(seed, "Change over a year")?.value).toBe("+12%");

    const t = tableOf(blocks);
    expect(t.rows.map((r) => r[0])).toEqual(["agency crm", "best crm for agencies", "crm for travel agencies"]);
    expect(t.rows[2].slice(1, 4)).toEqual([null, null, null]);
  });

  it("answers from one call when the other fails, and says so", async () => {
    const restore = quiet();
    post.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes("related")) throw new Error("40501 invalid field");
      return dfs({ seed_keyword_data: null, items: [kw("a b", 10)] });
    });
    const blocks = await tool.run(tool.input.parse({ keyword: "a" }), ctx());
    expect(tableOf(blocks).rows).toHaveLength(1);
    expect(textOf(blocks, "Partial result")).toBeDefined();
    expect(item(kvOf(blocks), "Seed keyword")?.status).toBe("warn");
    restore();
  });

  it("is upstream when both calls fail", async () => {
    const restore = quiet();
    post.mockImplementation(async () => {
      throw new Error("40200 payment required");
    });
    await expect(tool.run(tool.input.parse({ keyword: "a" }), ctx())).rejects.toMatchObject({ code: "upstream" });
    restore();
  });

  it("maps every form country and defaults to us", () => {
    expect(tool.input.parse({ keyword: "x" }).country).toBe("us");
    for (const c of ["us", "gb", "ca", "au", "ie", "de", "at", "ch", "fr", "it", "es", "nl", "be", "se", "dk", "pl", "pt", "in", "br", "mx"]) {
      expect(tool.input.safeParse({ keyword: "x", country: c }).success).toBe(true);
    }
    expect(issue(tool.input, { keyword: "x", country: "US" })).toMatch(/Choose a country/);
    expect(issue(tool.input, { keyword: "" })).toMatch(/Enter a seed keyword/);
    expect(endpoints()).toEqual([]);
  });
});
