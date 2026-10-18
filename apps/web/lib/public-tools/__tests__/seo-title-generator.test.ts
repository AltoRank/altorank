import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));
vi.mock("@/lib/billing/default-spend", () => ({ recordSpendByDefault: vi.fn(), spendClient: () => null }));

import { answer, ctx, quiet, issue, tableOf } from "./paid-helpers";
import { seoTitleGenerator as tool, estimateTitlePx, TITLE_PX_LIMIT } from "../tools/seo-title-generator";

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

  it("measures the way the site's SERP preview does: 18px Arial against 600px", () => {
    expect(TITLE_PX_LIMIT).toBe(600);
    // Arial at 18px: "W" is 944/1000 em, "i" 222/1000 em.
    expect(estimateTitlePx("W")).toBe(17);
    expect(estimateTitlePx("i")).toBe(4);
    expect(estimateTitlePx("Wi")).toBe(21);
    // Titles at the top of the 50-60 character target. The old ~20px table
    // put each over 630px and marked it "may be cut" while the headline
    // analyzer and SERP preview (canvas, 18px Arial) said it fits.
    for (const t of [
      "How to Choose a Project Management Tool for Remote Teams in 2026",
      "Small Business Accounting Software: Compare the Best Options Today",
      "Email Marketing for Ecommerce: Strategies That Increase Repeat Sales",
    ]) {
      const px = estimateTitlePx(t);
      expect(px, t).toBeGreaterThan(550);
      expect(px, t).toBeLessThanOrEqual(TITLE_PX_LIMIT);
    }
  });

  it("measures accented letters as their base letter and unknown characters as a digit", () => {
    expect(estimateTitlePx("é")).toBe(estimateTitlePx("e"));
    expect(estimateTitlePx("Ä")).toBe(estimateTitlePx("A"));
    expect(estimateTitlePx("日")).toBe(estimateTitlePx("0"));
  });

  it("does not flag a title that fits", async () => {
    const fits = "How to Choose a Project Management Tool for Remote Teams in 2026";
    create.mockResolvedValue(answer({ titles: [{ title: fits, angle: "how-to" }] }));
    const blocks = await tool.run(tool.input.parse({ topic: "choosing a PM tool" }), ctx());
    expect(String(tableOf(blocks).rows[0][3])).not.toMatch(/may be cut/);
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
