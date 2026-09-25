import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));
vi.mock("@/lib/billing/default-spend", () => ({ recordSpendByDefault: vi.fn(), spendClient: () => null }));

import { answer, ctx, quiet, issue, kvOf, codeOf, item } from "./paid-helpers";
import { socialMediaPostGenerator as tool, xLength } from "../tools/social-media-post-generator";

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  create.mockReset();
});
afterEach(() => vi.unstubAllEnvs());


describe("social-media-post-generator", () => {
  it("checks X length in code and flags figures not in the visitor's text", async () => {
    create.mockResolvedValue(
      answer({ posts: [{ text: "7 in 10 small sites block an AI crawler by accident." }, { text: "70% of sites do it." }, { text: "x".repeat(281) }] }),
    );
    const blocks = await tool.run(tool.input.parse({ topic_or_text: "7 in 10 small sites block an AI crawler.", platform: "x" }), ctx());
    const k = kvOf(blocks);
    expect(item(k, "Post 1")?.status).toBe("pass");
    expect(item(k, "Post 2")).toMatchObject({ status: "warn" });
    expect(item(k, "Post 2")?.value).toMatch(/check 70%/);
    expect(item(k, "Post 3")).toMatchObject({ status: "fail" });
    expect(item(k, "Post 3")?.value).toMatch(/1 over the limit/);
    expect(codeOf(blocks)).toHaveLength(3);
    expect(tool.cacheTtlMs).toBe(0);
  });

  it("counts X the way X does", () => {
    expect(xLength("hello")).toBe(5);
    expect(xLength("see https://example.com/a/very/long/path")).toBe(4 + 23);
    expect(xLength("日本")).toBe(4);
  });

  it("Instagram: flags more than 30 hashtags", async () => {
    const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ");
    create.mockResolvedValue(answer({ posts: [{ text: `Caption ${tags}` }] }));
    const blocks = await tool.run(tool.input.parse({ topic_or_text: "gardening", platform: "instagram" }), ctx());
    expect(item(kvOf(blocks), "Post 1")).toMatchObject({ status: "fail" });
  });

  it("defaults to LinkedIn", () => {
    expect(tool.input.parse({ topic_or_text: "x" }).platform).toBe("linkedin");
  });

  it("maps a model failure to upstream", async () => {
    const restore = quiet();
    create.mockRejectedValue(new Error("529 overloaded"));
    await expect(tool.run(tool.input.parse({ topic_or_text: "x" }), ctx())).rejects.toMatchObject({ code: "upstream" });
    restore();
  });

  it("validates the fields", () => {
    expect(issue(tool.input, { topic_or_text: "t".repeat(5001) })).toMatch(/under 5000/);
    expect(issue(tool.input, { topic_or_text: "x", platform: "facebook" })).toMatch(/Choose a platform/);
  });
});
