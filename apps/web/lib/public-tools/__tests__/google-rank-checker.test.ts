import { describe, it, expect, vi, beforeEach } from "vitest";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/seo/client", () => ({
  post,
  hasDataForSEOCredentials: () => true,
  DataForSEOError: class DataForSEOError extends Error {},
}));
vi.mock("@/lib/billing/default-spend", () => ({ recordSpendByDefault: vi.fn(), spendClient: () => null }));

import { dfs, ctx, quiet, issue, kvOf, tableOf, item } from "./paid-helpers";
import { googleRankChecker as tool, sameSite } from "../tools/google-rank-checker";

beforeEach(() => {
  post.mockReset();
});
const taskOf = (endpoint: string) => (post.mock.calls.find((c) => c[0] === endpoint)![1] as Array<Record<string, unknown>>)[0];

const org = (rank: number, domain: string, path = "/") => ({ type: "organic", rank_group: rank, rank_absolute: rank + 1, domain, url: `https://${domain}${path}`, title: `${domain} title` });

describe("google-rank-checker", () => {
  it("finds the domain's best organic position, subdomains included", async () => {
    post.mockResolvedValue(
      dfs({
        datetime: "2026-09-25 08:19:13 +00:00",
        items: [{ type: "ai_overview" }, org(1, "www.reddit.com"), org(2, "productive.io"), org(3, "www.zoho.com", "/crm/agencies/"), org(12, "help.zoho.com", "/x")],
      }),
    );
    const blocks = await tool.run(tool.input.parse({ domain: "https://www.Zoho.com/crm", keyword: "crm for agencies", country: "de" }), ctx());
    expect(taskOf("/serp/google/organic/live/advanced")).toMatchObject({ keyword: "crm for agencies", location_code: 2276, language_code: "de", depth: 100 });
    const k = kvOf(blocks);
    expect(item(k, "Position")).toMatchObject({ value: "#3 in organic results", status: "pass" });
    expect(item(k, "Ranking URL")?.value).toBe("https://www.zoho.com/crm/agencies/");
    expect(item(k, "Also ranks")?.value).toMatch(/#12/);
    const t = tableOf(blocks, "Top 10 organic results");
    expect(t.rows[2]).toEqual([3, "zoho.com", "https://www.zoho.com/crm/agencies/", "www.zoho.com title", "yes"]);
  });

  it("says not found without inventing a position", async () => {
    post.mockResolvedValue(dfs({ items: [org(1, "a.com"), org(2, "b.com")] }));
    const blocks = await tool.run(tool.input.parse({ domain: "example.com", keyword: "x" }), ctx());
    expect(item(kvOf(blocks), "Position")).toMatchObject({ value: "not in the top 2 organic results", status: "warn" });
  });

  it("matches hosts, not substrings", () => {
    expect(sameSite("www.example.com", "example.com")).toBe(true);
    expect(sameSite("blog.example.com", "example.com")).toBe(true);
    expect(sameSite("notexample.com", "example.com")).toBe(false);
  });

  it("maps a provider failure to upstream", async () => {
    const restore = quiet();
    post.mockImplementation(async () => {
      throw new Error("50000 internal error");
    });
    await expect(tool.run(tool.input.parse({ domain: "example.com", keyword: "x" }), ctx())).rejects.toMatchObject({ code: "upstream" });
    restore();
  });

  it("validates the fields", () => {
    expect(issue(tool.input, { domain: "localhost", keyword: "x" })).toMatch(/domain/);
    expect(issue(tool.input, { domain: "example.com" })).toMatch(/Enter a keyword/);
    expect(issue(tool.input, { domain: "example.com", keyword: "x", country: "zz" })).toMatch(/Choose a country/);
  });
});
