import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));
vi.mock("@/lib/billing/default-spend", () => ({ recordSpendByDefault: vi.fn(), spendClient: () => null }));

import { answer, ctx, quiet, issue, kvOf, listOf, textOf, item } from "./paid-helpers";
import { articleRewriter as tool } from "../tools/article-rewriter";
import { lostFigures } from "../prompt";

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  create.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

const sent = () => create.mock.calls[0][0] as { max_tokens: number; system: string; messages: Array<{ content: unknown }> };

describe("article-rewriter", () => {
  it("returns the rewrite and flags figures that went missing", async () => {
    create.mockResolvedValue(answer("```\nWe surveyed about 1,200 homes over three years.\n```"));
    const blocks = await tool.run(tool.input.parse({ text: "We surveyed 1,200 homes over 3 years; 23% composted.", tone: "plainer" }), ctx());
    expect(textOf(blocks, "Rewritten text")!.text).toBe("We surveyed about 1,200 homes over three years.");
    expect(item(kvOf(blocks), "Figures kept")!.status).toBe("warn");
    expect(listOf(blocks, "Figures to check")!.items.join(" ")).toMatch(/23%/);
    expect(sent().max_tokens).toBe(3072);
  });

  it("counts repeats: a number used twice and kept once is flagged", () => {
    expect(lostFigures("3 to 1, in 3 months", "3 to 1, in three months")).toEqual(["3"]);
    expect(lostFigures("1,500 words", "1500 words")).toEqual([]);
  });

  it("says so when the rewrite was cut off", async () => {
    create.mockResolvedValue(answer("Half a rewr", "max_tokens"));
    const blocks = await tool.run(tool.input.parse({ text: "Some text." }), ctx());
    expect(item(kvOf(blocks), "Complete")?.status).toBe("fail");
  });

  it("is not cached", () => {
    expect(tool.cacheTtlMs).toBe(0);
  });

  it("maps a model failure to upstream", async () => {
    const restore = quiet();
    create.mockRejectedValue(new Error("529 overloaded"));
    await expect(tool.run(tool.input.parse({ text: "x" }), ctx())).rejects.toMatchObject({ code: "upstream" });
    restore();
  });

  it("enforces the 1,500-word and tone limits", () => {
    expect(issue(tool.input, { text: "word ".repeat(1501) })).toMatch(/more than 1,500 words/);
    expect(issue(tool.input, { text: "ok", tone: "t".repeat(41) })).toMatch(/under 40/);
    expect(issue(tool.input, { text: "" })).toMatch(/Paste some text/);
  });
});
