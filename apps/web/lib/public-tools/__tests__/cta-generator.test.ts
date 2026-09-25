import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));
vi.mock("@/lib/billing/default-spend", () => ({ recordSpendByDefault: vi.fn(), spendClient: () => null }));

import { answer, ctx, quiet, issue, tableOf, listOf } from "./paid-helpers";
import { ctaGenerator as tool } from "../tools/cta-generator";

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  create.mockReset();
});
afterEach(() => vi.unstubAllEnvs());


describe("cta-generator", () => {
  it("lists options and flags terms the offer never stated", async () => {
    create.mockResolvedValue(
      answer({
        ctas: [
          { button: "Start your trial", supporting: "Seven days, then monthly billing" },
          { button: "Try it free", supporting: "No credit card required" },
          { button: "Get started with the invoicing app today", supporting: "" },
        ],
      }),
    );
    const blocks = await tool.run(tool.input.parse({ offer: "a 7-day trial, card required", audience: "" }), ctx());
    const t = tableOf(blocks, "CTA options");
    expect(t.rows).toHaveLength(3);
    expect(String(t.rows[2][2])).toMatch(/long for a button/);
    const flags = listOf(blocks, "Check these")!.items.join(" ");
    expect(flags).toMatch(/promises free/);
    expect(flags).toMatch(/promises no card required/);
  });

  it("does not flag free when the offer says free", async () => {
    create.mockResolvedValue(answer({ ctas: [{ button: "Get the free guide", supporting: "" }] }));
    const blocks = await tool.run(tool.input.parse({ offer: "a free PDF guide" }), ctx());
    expect(listOf(blocks, "Check these")).toBeUndefined();
  });

  it("maps a model failure to upstream", async () => {
    const restore = quiet();
    create.mockRejectedValue(new Error("529 overloaded"));
    await expect(tool.run(tool.input.parse({ offer: "x" }), ctx())).rejects.toMatchObject({ code: "upstream" });
    restore();
  });

  it("validates the fields", () => {
    expect(issue(tool.input, {})).toMatch(/Enter what you are offering/);
    expect(issue(tool.input, { offer: "o".repeat(301) })).toMatch(/under 300/);
    expect(issue(tool.input, { offer: "ok", audience: "a".repeat(201) })).toMatch(/under 200/);
  });
});
