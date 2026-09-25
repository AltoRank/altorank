import { describe, it, expect, vi, beforeEach } from "vitest";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/seo/client", () => ({
  post,
  hasDataForSEOCredentials: () => true,
  DataForSEOError: class DataForSEOError extends Error {},
}));
vi.mock("@/lib/billing/default-spend", () => ({ recordSpendByDefault: vi.fn(), spendClient: () => null }));

import { dfs, ctx, quiet, issue, kvOf, tableOf, textOf, item } from "./paid-helpers";
import { websiteWorthCalculator as tool, markets } from "../tools/website-worth-calculator";

beforeEach(() => {
  post.mockReset();
});
const taskOf = (endpoint: string) => (post.mock.calls.find((c) => c[0] === endpoint)![1] as Array<Record<string, unknown>>)[0];

const row = (location_code: number, language_code: string, etv: number, cost: number, count: number) => ({
  location_code,
  language_code,
  metrics: { organic: { etv, estimated_paid_traffic_cost: cost, count } },
});

describe("website-worth-calculator", () => {
  it("sums every market into a labelled traffic value, not a valuation", async () => {
    post.mockResolvedValue(dfs({ total_count: 3, items: [row(2826, "en", 1489, 4814, 679), row(2840, "en", 21067, 101202, 4800), row(2012, "ar", 1.6, 0, 1)] }));
    const blocks = await tool.run(tool.input.parse({ domain: "www.example.com" }), ctx());
    expect(taskOf("/dataforseo_labs/google/domain_rank_overview/live")).toEqual({ target: "example.com", limit: 200 });
    const k = kvOf(blocks);
    expect(item(k, "Estimated monthly traffic value (USD)")?.value).toBe("$106,016 per month");
    expect(item(k, "Modelled monthly organic visits")?.value).toBe("22,558");
    const t = tableOf(blocks, "Largest markets");
    expect(t.rows[0].slice(0, 2)).toEqual(["United States", "English"]);
    expect(t.rows[2][0]).toBe("Algeria");
    expect(textOf(blocks, "What this number is, and is not")!.text).toMatch(/not a valuation/);
  });

  it("flags an undercount when the provider has more markets than returned", async () => {
    post.mockResolvedValue(dfs({ total_count: 300, items: [row(2840, "en", 10, 10, 1)] }));
    const blocks = await tool.run(tool.input.parse({ domain: "example.com" }), ctx());
    expect(item(kvOf(blocks), "Markets counted")).toMatchObject({ status: "warn" });
  });

  it("says no data rather than $0", async () => {
    post.mockResolvedValue(dfs({ total_count: 0, items: [] }));
    const blocks = await tool.run(tool.input.parse({ domain: "example.com" }), ctx());
    expect(item(kvOf(blocks), "Estimated monthly traffic value")?.value).toBe("no data");
    expect(markets([row(2840, "en", 0, 0, 0)])).toEqual([]);
  });

  it("maps a provider failure to upstream", async () => {
    const restore = quiet();
    post.mockImplementation(async () => {
      throw new Error("down");
    });
    await expect(tool.run(tool.input.parse({ domain: "example.com" }), ctx())).rejects.toMatchObject({ code: "upstream" });
    restore();
  });

  it("validates the domain", () => {
    expect(issue(tool.input, { domain: "https://intranet.corp" })).toMatch(/not a public site/);
  });
});
