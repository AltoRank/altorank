import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));
vi.mock("@/lib/billing/default-spend", () => ({ recordSpendByDefault: vi.fn(), spendClient: () => null }));

import { answer, ctx, quiet, issue, tableOf } from "./paid-helpers";
import { seoTitleGenerator as tool, estimateTitlePx } from "../tools/seo-title-generator";

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  create.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

const sent = () => create.mock.calls[0][0] as { max_tokens: number; system: string; messages: Array<{ content: unknown }> };

describe("seo-title-generator", () => {
  it("measures each option and marks the keyword", async () => {
    const long = "Restaurant Accounting Software Compared for Busy Small Kitchens Worldwide";
    create.mockResolvedValue(answer({ titles: [{ title: "CRM for Agencies: How to Choose One", angle: "how-to" }, { title: long, angle: "comparison" }] }));
    const blocks = await tool.run(tool.input.parse({ topic: "choosing a CRM", keyword: "CRM for agencies" }), ctx());
    const t = tableOf(blocks, "Title tag options");
    expect(t.columns).toContain("Has keyword");
    expect(t.rows[0][4]).toBe("yes");
    expect(t.rows[1][4]).toBe("no");
    expect(String(t.rows[1][3])).toMatch(/may be cut/);
    expect(sent().max_tokens).toBe(700);
    expect(JSON.stringify(sent().messages)).toContain("<keyword>");
  });

  it("drops the keyword column when none is given, and treats an empty keyword as none", async () => {
    create.mockResolvedValue(answer({ titles: [{ title: "A title", angle: "x" }] }));
    const blocks = await tool.run(tool.input.parse({ topic: "a page", keyword: "  " }), ctx());
    expect(tableOf(blocks).columns).not.toContain("Has keyword");
  });

  it("estimates wider for capitals than for narrow letters", () => {
    expect(estimateTitlePx("WWWW")).toBeGreaterThan(estimateTitlePx("iiii"));
  });

  it("maps a model failure to upstream", async () => {
    const restore = quiet();
    create.mockRejectedValue(new Error("529 overloaded"));
    await expect(tool.run(tool.input.parse({ topic: "x" }), ctx())).rejects.toMatchObject({ code: "upstream" });
    restore();
  });

  it("validates the form's fields", () => {
    expect(issue(tool.input, {})).toMatch(/Enter what the page is about/);
    expect(issue(tool.input, { topic: "x".repeat(201) })).toMatch(/under 200/);
    expect(issue(tool.input, { topic: "ok", keyword: "k".repeat(101) })).toMatch(/under 100/);
  });
});
