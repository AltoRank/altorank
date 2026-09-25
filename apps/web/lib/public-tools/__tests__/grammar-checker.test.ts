import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));
vi.mock("@/lib/billing/default-spend", () => ({ recordSpendByDefault: vi.fn(), spendClient: () => null }));

import { answer, ctx, quiet, issue, kvOf, tableOf, codeOf, item } from "./paid-helpers";
import { grammarChecker as tool, applyIssues } from "../tools/grammar-checker";

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  create.mockReset();
});
afterEach(() => vi.unstubAllEnvs());


const TEXT = "Its easyer than you think. Their is a bin for it.";

describe("grammar-checker", () => {
  it("tables the issues and applies only them to the text", async () => {
    create.mockResolvedValue(
      answer({
        issues: [
          { original: "Their is", suggestion: "There is", why: "homophone", type: "grammar" },
          { original: "Its easyer", suggestion: "It's easier", why: "contraction, spelling", type: "spelling" },
          { original: "not in the text", suggestion: "x", why: "invented", type: "grammar" },
        ],
      }),
    );
    const blocks = await tool.run(tool.input.parse({ text: TEXT }), ctx());
    const t = tableOf(blocks, "Suggested corrections");
    expect(t.columns).toEqual(["Original", "Suggestion", "Why"]);
    expect(t.rows.map((r) => r[0])).toEqual(["Its easyer", "Their is"]);
    expect(codeOf(blocks)[0].code).toBe("It's easier than you think. There is a bin for it.");
    expect(item(kvOf(blocks), "Issues found")?.value).toBe("2");
    expect(tool.cacheTtlMs).toBe(0);
  });

  it("applyIssues skips overlaps and no-op suggestions, and uses later occurrences for repeats", () => {
    const { kept, corrected } = applyIssues("teh cat and teh dog", [
      { original: "teh", suggestion: "the", why: "", type: "spelling" },
      { original: "teh", suggestion: "the", why: "", type: "spelling" },
      { original: "teh cat", suggestion: "the cat", why: "", type: "spelling" },
      { original: "dog", suggestion: "dog", why: "", type: "grammar" },
    ]);
    expect(kept).toHaveLength(2);
    expect(corrected).toBe("the cat and the dog");
  });

  it("reports a clean text as clean", async () => {
    create.mockResolvedValue(answer({ issues: [] }));
    const blocks = await tool.run(tool.input.parse({ text: "All good here." }), ctx());
    expect(item(kvOf(blocks), "Issues found")).toMatchObject({ value: "none", status: "pass" });
  });

  it("maps a model failure to upstream", async () => {
    const restore = quiet();
    create.mockRejectedValue(new Error("529 overloaded"));
    await expect(tool.run(tool.input.parse({ text: "x" }), ctx())).rejects.toMatchObject({ code: "upstream" });
    restore();
  });

  it("enforces the 1,500-word limit", () => {
    expect(issue(tool.input, { text: "w ".repeat(1501) })).toMatch(/1,500 words/);
  });
});
