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
const tasksOf = (endpoint: string) => post.mock.calls.filter((c) => c[0] === endpoint).map((c) => (c[1] as Array<Record<string, unknown>>)[0]);
const byOrder = (order: string) => (endpoint: string, tasks: Array<Record<string, unknown>>) =>
  endpoint.includes("backlinks/live") && (tasks[0].order_by as string[])[0] === order;

const SUMMARY = { backlinks: 8508, referring_domains: 10, referring_domains_nofollow: 6, referring_ips: 10, rank: 273, broken_backlinks: 0, first_seen: "2026-05-02 16:45:24 +00:00", backlinks_spam_score: 12 };
const LINK = { url_from: "https://a.example/post", domain_from: "a.example", domain_from_rank: 344, url_to: "https://example.com/", anchor: "Example", dofollow: true, first_seen: "2026-07-31 19:52:27 +00:00", backlink_spam_score: 3 };
const NEW_LINK = { url_from: "https://small.example/new", domain_from: "small.example", domain_from_rank: 4, url_to: "https://example.com/pricing", anchor: "pricing", dofollow: false, first_seen: "2026-10-14 08:00:00 +00:00", backlink_spam_score: 74 };

describe("backlink-checker", () => {
  it("shows the counts and a sample, one link per referring domain", async () => {
    post.mockImplementation(async (endpoint: string) => (endpoint.includes("summary") ? dfs(SUMMARY) : dfs({ total_count: 1, items: [LINK] })));
    const blocks = await tool.run(tool.input.parse({ domain: "Example.com" }), ctx());
    expect(taskOf("/backlinks/backlinks/live")).toMatchObject({ target: "example.com", mode: "one_per_domain", limit: 20 });
    const k = kvOf(blocks);
    expect(item(k, "Backlinks")?.value).toBe("8,508");
    expect(item(k, "Referring domains linking nofollow")?.value).toBe("60%");
    expect(item(k, "First seen by the crawler")?.value).toBe("2026-05-02");
    expect(item(k, "Backlink spam score (DataForSEO, 0-100)")).toMatchObject({ value: "12", status: "info" });
    expect(tableOf(blocks, "Sample: one link from each of the 1 strongest referring domains").rows[0]).toEqual([
      "https://a.example/post", 344, 3, "https://example.com/", "Example", "follow", "2026-07-31",
    ]);
  });

  it("also lists the newest links, so a new link from a small site shows up", async () => {
    post.mockImplementation(async (endpoint: string, tasks: Array<Record<string, unknown>>) => {
      if (endpoint.includes("summary")) return dfs({ ...SUMMARY, backlinks_spam_score: 64 });
      return byOrder("first_seen,desc")(endpoint, tasks) ? dfs({ total_count: 1, items: [NEW_LINK] }) : dfs({ total_count: 1, items: [LINK] });
    });
    const blocks = await tool.run(tool.input.parse({ domain: "example.com" }), ctx());
    const lists = tasksOf("/backlinks/backlinks/live");
    expect(lists).toHaveLength(2);
    expect(lists).toContainEqual(expect.objectContaining({ mode: "as_is", limit: 20, order_by: ["first_seen,desc"] }));
    expect(lists).toContainEqual(expect.objectContaining({ mode: "one_per_domain", order_by: ["domain_from_rank,desc"] }));
    expect(tableOf(blocks, "Newest: the live link the crawler found most recently").rows[0]).toEqual([
      "https://small.example/new", 4, 74, "https://example.com/pricing", "pricing", "nofollow", "2026-10-14",
    ]);
    expect(item(kvOf(blocks), "Backlink spam score (DataForSEO, 0-100)")).toMatchObject({ value: "64: high", status: "warn" });
    expect(tool.estimateCents).toBeLessThanOrEqual(10);
  });

  it("keeps the strongest-domains sample when only the newest list fails", async () => {
    const restore = quiet();
    post.mockImplementation(async (endpoint: string, tasks: Array<Record<string, unknown>>) => {
      if (endpoint.includes("summary")) return dfs(SUMMARY);
      if (byOrder("first_seen,desc")(endpoint, tasks)) throw new Error("timeout");
      return dfs({ total_count: 1, items: [LINK] });
    });
    const blocks = await tool.run(tool.input.parse({ domain: "example.com" }), ctx());
    expect(tableOf(blocks, "Sample: one link from each of the 1 strongest referring domains").rows).toHaveLength(1);
    expect(textOf(blocks, "Newest links")).toBeDefined();
    restore();
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
