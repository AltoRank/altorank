import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));
vi.mock("@/lib/billing/default-spend", () => ({ recordSpendByDefault: vi.fn(), spendClient: () => null }));

import { answer, ctx, quiet, issue, kvOf, tableOf, textOf, item } from "./paid-helpers";
import { adCopyGenerator as tool, pickFitting } from "../tools/ad-copy-generator";

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  create.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

const sent = () => create.mock.calls[0][0] as { max_tokens: number; system: string; messages: Array<{ content: unknown }> };

describe("ad-copy-generator", () => {
  it("Google: keeps lines that fit first and marks the rest over", async () => {
    const fitting = Array.from({ length: 14 }, (_, i) => `Headline number ${i + 1}`);
    create.mockResolvedValue(
      answer({
        headlines: ["This headline is far too long for Google", ...fitting],
        descriptions: ["Short and within the ninety character limit.", "d".repeat(95)],
      }),
    );
    const blocks = await tool.run(tool.input.parse({ product: "an invoicing app" }), ctx());
    expect(item(kvOf(blocks), "Headlines within 30 characters")).toMatchObject({ value: "14 of 15", status: "warn" });
    const h = tableOf(blocks, "Headlines");
    expect(h.rows[0][2]).toBe("yes");
    expect(h.rows[14][2]).toBe("over by 10");
    expect(tableOf(blocks, "Descriptions").rows[1][2]).toBe("over by 5");
    expect(textOf(blocks, "Over the limit")).toBeDefined();
  });

  it("pickFitting dedupes and orders fitting lines first", () => {
    expect(pickFitting(["long line here", "a", "a", "b"], 5, 3)).toEqual(["a", "b", "long line here"]);
  });

  it("LinkedIn: checks the fold and uses the platform prompt", async () => {
    create.mockResolvedValue(answer({ variations: [{ primary: "p".repeat(200), headline: "Short headline", description: "d" }] }));
    const blocks = await tool.run(tool.input.parse({ product: "an app", platform: "linkedin" }), ctx());
    const t = tableOf(blocks, "LinkedIn variations");
    expect(t.rows[0][2]).toBe("cut after 150");
    expect(t.rows[0][4]).toBe("yes");
    expect(sent().system).toMatch(/LinkedIn/);
  });

  it("defaults the platform to Google", () => {
    expect(tool.input.parse({ product: "x" }).platform).toBe("google");
  });

  it("maps a model failure to upstream", async () => {
    const restore = quiet();
    create.mockRejectedValue(new Error("529 overloaded"));
    await expect(tool.run(tool.input.parse({ product: "x", platform: "meta" }), ctx())).rejects.toMatchObject({ code: "upstream" });
    restore();
  });

  it("validates the fields", () => {
    expect(issue(tool.input, { product: "x", platform: "tiktok" })).toMatch(/Choose a platform/);
    expect(issue(tool.input, { product: "p".repeat(601) })).toMatch(/under 600/);
  });
});
