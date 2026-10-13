import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));
vi.mock("@/lib/billing/default-spend", () => ({ recordSpendByDefault: vi.fn(), spendClient: () => null }));

import { answer, ctx, quiet, issue, listOf, textOf } from "./paid-helpers";
import { articleSummarizer as tool } from "../tools/article-summarizer";

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  create.mockReset();
});
afterEach(() => vi.unstubAllEnvs());


describe("article-summarizer", () => {
  it("returns a summary and key points", async () => {
    create.mockResolvedValue(answer({ summary: "A study found composting cut waste.", key_points: ["23% less waste", "self-selected sample"] }));
    const blocks = await tool.run(tool.input.parse({ text: "A long article about composting." }), ctx());
    expect(textOf(blocks, "Summary")!.text).toMatch(/composting cut waste/);
    expect(listOf(blocks, "Key points")!.items).toHaveLength(2);
    expect(tool.cacheTtlMs).toBe(0);
  });

  it("maps a model failure to upstream", async () => {
    const restore = quiet();
    create.mockRejectedValue(new Error("529 overloaded"));
    await expect(tool.run(tool.input.parse({ text: "x" }), ctx())).rejects.toMatchObject({ code: "upstream" });
    restore();
  });

  it("treats an unreadable answer as upstream", async () => {
    const restore = quiet();
    create.mockResolvedValue(answer("sorry, no JSON today"));
    await expect(tool.run(tool.input.parse({ text: "x" }), ctx())).rejects.toMatchObject({ code: "upstream" });
    restore();
  });

  it("caps pasted text at 20,000 characters", () => {
    expect(issue(tool.input, { text: "a".repeat(20_001) })).toMatch(/20,000 characters/);
  });
});
