import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));
vi.mock("@/lib/billing/default-spend", () => ({ recordSpendByDefault: vi.fn(), spendClient: () => null }));

import { answer, ctx, quiet, issue, listOf } from "./paid-helpers";
import { lsiKeywordGenerator as tool } from "../tools/lsi-keyword-generator";

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  create.mockReset();
});
afterEach(() => vi.unstubAllEnvs());


describe("lsi-keyword-generator", () => {
  it("lists the groups, deduplicated, and skips empty ones", async () => {
    create.mockResolvedValue(answer({ subtopics: ["Bins", "bins", "Moisture"], entities: [], related_terms: ["humus"], questions: ["How long does it take?"] }));
    const blocks = await tool.run(tool.input.parse({ keyword: "home composting" }), ctx());
    expect(listOf(blocks, "Subtopics a complete page covers")!.items).toEqual(["bins", "Moisture"]);
    expect(listOf(blocks, "Entities")).toBeUndefined();
    expect(JSON.stringify(blocks)).not.toMatch(/latent semantic/i);
  });

  it("maps a model failure to upstream", async () => {
    const restore = quiet();
    create.mockRejectedValue(new Error("529 overloaded"));
    await expect(tool.run(tool.input.parse({ keyword: "x" }), ctx())).rejects.toMatchObject({ code: "upstream" });
    restore();
  });

  it("requires the keyword", () => {
    expect(issue(tool.input, {})).toMatch(/Enter a keyword/);
    expect(issue(tool.input, { keyword: "k".repeat(101) })).toMatch(/under 100/);
  });
});
