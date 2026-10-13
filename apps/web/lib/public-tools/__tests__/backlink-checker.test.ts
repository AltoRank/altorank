import { describe, it, expect, vi, beforeEach } from "vitest";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/seo/client", () => ({
  post,
  hasDataForSEOCredentials: () => true,
  DataForSEOError: class DataForSEOError extends Error {},
}));
vi.mock("@/lib/billing/default-spend", () => ({ recordSpendByDefault: vi.fn(), spendClient: () => null }));

import { dfs, ctx, quiet, issue, kvOf, tableOf, textOf, item } from "./paid-helpers";
import { backlinkChecker as tool } from "../tools/backlink-checker";

beforeEach(() => {
  post.mockReset();
});
const taskOf = (endpoint: string) => (post.mock.calls.find((c) => c[0] === endpoint)![1] as Array<Record<string, unknown>>)[0];

const SUMMARY = { backlinks: 8508, referring_domains: 10, referring_domains_nofollow: 6, referring_ips: 10, rank: 273, broken_backlinks: 0, first_seen: "2026-05-02 16:45:24 +00:00" };
const LINK = { url_from: "https://a.example/post", domain_from: "a.example", domain_from_rank: 344, url_to: "https://example.com/", anchor: "Example", dofollow: true, first_seen: "2026-07-31 19:52:27 +00:00" };

describe("backlink-checker", () => {
  it("shows the counts and a sample, one link per referring domain", async () => {
    post.mockImplementation(async (endpoint: string) => (endpoint.includes("summary") ? dfs(SUMMARY) : dfs({ total_count: 1, items: [LINK] })));
    const blocks = await tool.run(tool.input.parse({ domain: "Example.com" }), ctx());
    expect(taskOf("/backlinks/backlinks/live")).toMatchObject({ target: "example.com", mode: "one_per_domain", limit: 20 });
    const k = kvOf(blocks);
    expect(item(k, "Backlinks")?.value).toBe("8,508");
    expect(item(k, "Referring domains linking nofollow")?.value).toBe("60%");
    expect(item(k, "First seen by the crawler")?.value).toBe("2026-05-02");
    expect(tableOf(blocks).rows[0]).toEqual(["https://a.example/post", 344, "https://example.com/", "Example", "follow", "2026-07-31"]);
  });

  it("keeps the counts when only the sample fails", async () => {
    const restore = quiet();
    post.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes("summary")) return dfs(SUMMARY);
      throw new Error("timeout");
    });
    const blocks = await tool.run(tool.input.parse({ domain: "example.com" }), ctx());
    expect(item(kvOf(blocks), "Backlinks")?.value).toBe("8,508");
    expect(textOf(blocks, "Sample")).toBeDefined();
    restore();
  });

  it("says so when the index has no links", async () => {
    post.mockResolvedValue(dfs({ backlinks: 0, referring_domains: 0 }));
    const blocks = await tool.run(tool.input.parse({ domain: "new-site.com" }), ctx());
    expect(item(kvOf(blocks), "Backlinks found")?.value).toBe("none");
  });

  it("fails with a clear upstream sentence when the backlinks API is refused", async () => {
    const restore = quiet();
    post.mockImplementation(async () => {
      throw new Error("40204 Access denied. Visit Plans and Subscriptions");
    });
    await expect(tool.run(tool.input.parse({ domain: "example.com" }), ctx())).rejects.toMatchObject({
      code: "upstream",
      message: expect.stringMatching(/backlink index/),
    });
    restore();
  });

  it("validates the domain", () => {
    expect(issue(tool.input, {})).toMatch(/Enter a domain/);
    expect(issue(tool.input, { domain: "not a domain" })).toMatch(/does not look like a domain/);
  });
});
