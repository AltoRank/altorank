import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));
vi.mock("@/lib/billing/default-spend", () => ({ recordSpendByDefault: vi.fn(), spendClient: () => null }));

import { answer, ctx, quiet, issue, codeOf } from "./paid-helpers";
import { blogOutlineGenerator as tool, outlineMarkdown } from "../tools/blog-outline-generator";

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  create.mockReset();
});
afterEach(() => vi.unstubAllEnvs());


const OUTLINE = {
  title: "Apartment Composting",
  sections: [
    { h2: "Why compost indoors", answers: "the benefit", h3: [] },
    { h2: "Pick a method", answers: "which method", h3: ["Worm bins", "Bokashi"] },
  ],
};

describe("blog-outline-generator", () => {
  it("renders the outline as Markdown headings", async () => {
    create.mockResolvedValue(answer(OUTLINE));
    const blocks = await tool.run(tool.input.parse({ topic: "apartment composting", keyword: "" }), ctx());
    const [md] = codeOf(blocks);
    expect(md.language).toBe("markdown");
    expect(md.title).toBe("Outline: 2 sections, 2 subsections");
    expect(md.code).toContain("# Apartment Composting");
    expect(md.code).toContain("### Bokashi");
  });

  it("keeps heading order", () => {
    const md = outlineMarkdown(OUTLINE);
    expect(md.indexOf("## Why compost")).toBeLessThan(md.indexOf("## Pick a method"));
  });

  it("maps a model failure to upstream", async () => {
    const restore = quiet();
    create.mockRejectedValue(new Error("529 overloaded"));
    await expect(tool.run(tool.input.parse({ topic: "x" }), ctx())).rejects.toMatchObject({ code: "upstream" });
    restore();
  });

  it("rejects an outline with too few sections as unreadable", async () => {
    const restore = quiet();
    create.mockResolvedValue(answer({ title: "t", sections: [{ h2: "only one" }] }));
    await expect(tool.run(tool.input.parse({ topic: "x" }), ctx())).rejects.toMatchObject({ code: "upstream" });
    restore();
  });

  it("validates the fields", () => {
    expect(issue(tool.input, { keyword: "k" })).toMatch(/Enter a topic/);
  });
});
