import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));
vi.mock("@/lib/billing/default-spend", () => ({ recordSpendByDefault: vi.fn(), spendClient: () => null }));

import { answer, ctx, quiet, issue, tableOf, textOf } from "./paid-helpers";
import { contentIdeaGenerator as tool } from "../tools/content-idea-generator";

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  create.mockReset();
});
afterEach(() => vi.unstubAllEnvs());


describe("content-idea-generator", () => {
  it("tables ideas with angle and format, and says they are not search data", async () => {
    create.mockResolvedValue(answer({ ideas: [{ title: "Daily cash-up checklist", angle: "for managers", format: "checklist" }] }));
    const blocks = await tool.run(tool.input.parse({ topic: "restaurant bookkeeping" }), ctx());
    expect(tableOf(blocks).rows).toEqual([["Daily cash-up checklist", "for managers", "checklist"]]);
    expect(textOf(blocks, "Before you write")!.text).toMatch(/not from search data/);
  });

  it("maps a model failure to upstream", async () => {
    const restore = quiet();
    create.mockRejectedValue(new Error("529 overloaded"));
    await expect(tool.run(tool.input.parse({ topic: "x" }), ctx())).rejects.toMatchObject({ code: "upstream" });
    restore();
  });

  it("validates the topic", () => {
    expect(issue(tool.input, {})).toMatch(/Enter a topic or niche/);
  });
});
