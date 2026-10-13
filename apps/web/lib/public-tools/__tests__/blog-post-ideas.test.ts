import { describe, it, expect, vi, beforeEach } from "vitest";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/seo/client", () => ({
  post,
  hasDataForSEOCredentials: () => true,
  DataForSEOError: class DataForSEOError extends Error {},
}));
vi.mock("@/lib/billing/default-spend", () => ({ recordSpendByDefault: vi.fn(), spendClient: () => null }));

import { dfs, ctx, quiet, issue, tableOf, textOf } from "./paid-helpers";
import { blogPostIdeas as tool, ideaKey, groupIdeas, strayNumberSuffix } from "../tools/blog-post-ideas";

beforeEach(() => {
  post.mockReset();
});

const kw = (keyword: string, volume: number | null) => ({ keyword, keyword_info: { search_volume: volume } });

describe("blog-post-ideas", () => {
  it("builds grouped ideas from question and long-tail searches", async () => {
    post.mockImplementation(async (_e: string, tasks: Array<{ filters?: unknown }>) =>
      tasks[0].filters
        ? dfs({ items: [kw("how to start composting at home", 720), kw("how to start home composting", 720), kw("what is home composting", 50), kw("how do i set up a home composting system 3d", 110), kw("can you compost at home", 30)] })
        : dfs({ items: [kw("home composting", 5000), kw("home composting bin", 900), kw("how to start composting at home", 720)] }),
    );
    const blocks = await tool.run(tool.input.parse({ topic: "Home composting" }), ctx());

    const filtered = post.mock.calls.find((c) => (c[1] as Array<{ filters?: unknown }>)[0].filters)!;
    expect((filtered[1] as Array<Record<string, unknown>>)[0]).toMatchObject({ keyword: "home composting", location_code: 2840, language_code: "en" });

    const t = tableOf(blocks, "Post ideas from real searches");
    const ideas = t.rows.map((r) => r[0]);
    expect(ideas[0]).toBe("How to start composting at home?");
    expect(t.rows[0][3]).toBe("how to start home composting");
    expect(ideas).toContain("What is home composting?");
    expect(ideas).toContain("home composting bin");
    expect(ideas).not.toContain("home composting");
    expect(ideas.some((i) => String(i).includes("3d"))).toBe(false);
    expect(t.rows.find((r) => r[0] === "Can you compost at home?")?.[1]).toBe("Yes/no questions");
  });

  it("merges phrasings of one need", () => {
    expect(ideaKey("how to start composting at home")).toBe(ideaKey("how to start home composting"));
    expect(groupIdeas([{ keyword: "compost bins", volume: 5, difficulty: null, cpc: null, intent: null }, { keyword: "compost bin", volume: 9, difficulty: null, cpc: null, intent: null }])).toHaveLength(1);
    expect(strayNumberSuffix("home composting system 3", "home composting")).toBe(true);
    expect(strayNumberSuffix("windows 11 tips", "windows 11")).toBe(false);
  });

  it("says so when nothing is found", async () => {
    post.mockResolvedValue(dfs({ items: [] }));
    const blocks = await tool.run(tool.input.parse({ topic: "zzqx" }), ctx());
    expect(textOf(blocks, "No ideas found")).toBeDefined();
  });

  it("is upstream when both lookups fail", async () => {
    const restore = quiet();
    post.mockImplementation(async () => {
      throw new Error("down");
    });
    await expect(tool.run(tool.input.parse({ topic: "x" }), ctx())).rejects.toMatchObject({ code: "upstream" });
    restore();
  });

  it("validates the topic", () => {
    expect(issue(tool.input, { topic: "t".repeat(201) })).toMatch(/under 200/);
  });
});
