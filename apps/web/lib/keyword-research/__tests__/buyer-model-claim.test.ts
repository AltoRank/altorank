// ---------------------------------------------------------------------------
// A structured call's claim: realistic, floored, and sized to its grant
// ---------------------------------------------------------------------------
//
// A production first look (2026-10-15) had $0.084 left for its buyer test.
// Every batch claimed its ceiling - 8,000 output tokens at Sonnet's rate,
// about $0.085 - for a reply that costs about $0.025, so every batch was
// refused and the phrases were never judged. A call now claims its most
// when the room has it and otherwise what the room has, down to a floor,
// and is sent with the output its grant pays for: the run's dollar stays
// hard, and a room that holds the reply twice over is not refused.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { create, clientOptions } = vi.hoisted(() => ({ create: vi.fn(), clientOptions: [] as unknown[] }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    constructor(opts: unknown) { clientOptions.push(opts); }
    messages = { create };
  },
}));
vi.mock("@/lib/billing/default-spend", () => ({ recordSpendByDefault: vi.fn(), spendClient: () => null }));

import { askStructured, claimSize, STRUCTURED_MAX_RETRIES, STRUCTURED_TIMEOUT_MS } from "../buyer-model";
import { buyerFitPrompt, buyerFitTokens, BUYER_FIT_SCHEMA, judgeBuyerFit, MAX_JUDGED } from "../buyer-fit";
import { memoryRunBudget } from "@/lib/billing/run-budget";
import { withSpendScope } from "@/lib/billing/spend-scope";
import { anthropicModel } from "@/lib/ai/models";
import { anthropicCost } from "@/lib/billing/spend";

const business = { name: "Acme Studio", description: "Acme Studio sells model railway kits to hobbyists.", offerings: ["model railway kits"], audiences: ["railway modellers"] };
const phrases = Array.from({ length: MAX_JUDGED }, (_, i) => `acme kit ${String(i).padStart(3, "0")}`);
const model = anthropicModel("decision");
/** What a 40-phrase reply costs, as measured: about 1,600 tokens out. */
const usage = { input_tokens: 1800, output_tokens: 1600 };
const reply = (prompt: string) => {
  const asked = JSON.parse(prompt.slice(prompt.lastIndexOf("PHRASES") + "PHRASES".length).trim()) as string[];
  return { content: [{ type: "text", text: JSON.stringify({ verdicts: asked.map((t) => ({ t, s: "solution", r: "a modeller" })) }) }], usage };
};

beforeEach(() => {
  create.mockReset();
  clientOptions.length = 0;
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  create.mockImplementation(async (p: { messages: Array<{ content: string }> }) => reply(p.messages[0].content));
});

describe("a structured call's claim", () => {
  const promptChars = buyerFitPrompt("Name: Acme Studio", phrases).length + JSON.stringify(BUYER_FIT_SCHEMA).length;
  const full = buyerFitTokens(MAX_JUDGED);
  const size = claimSize(model, promptChars, full.maxTokens, full.minTokens);

  it("is asked with what its grant pays for, never more and never under its floor", () => {
    expect(size.maxTokensFor(size.wantUsd)).toBe(full.maxTokens);
    expect(size.maxTokensFor(size.minUsd)).toBe(full.minTokens);
    const between = (size.wantUsd + size.minUsd) / 2;
    const sent = size.maxTokensFor(between);
    expect(sent).toBeGreaterThan(full.minTokens);
    expect(sent).toBeLessThan(full.maxTokens);
    // The most that reply can cost is inside what was granted.
    expect(anthropicCost(model, Math.ceil(promptChars / 2.5) + 64, sent)!).toBeLessThanOrEqual(between + 1e-9);
  });

  it("asks a full batch when the room is short of its ceiling but holds its floor (the $0.084 that refused every batch)", async () => {
    expect(size.wantUsd).toBeGreaterThan(0.084);
    expect(size.minUsd).toBeLessThan(0.084);
    const budget = memoryRunBudget("run-a", 0.084, {});
    const out = await withSpendScope({ budget, stage: "buyer_fit" }, () => judgeBuyerFit(business, phrases, {}));
    expect(out.verdicts.size).toBe(MAX_JUDGED);
    const sent = create.mock.calls[0][0] as { max_tokens: number };
    expect(sent.max_tokens).toBeLessThan(full.maxTokens);
    expect(sent.max_tokens).toBeGreaterThanOrEqual(full.minTokens);
    // Settled at what it cost: the room comes back.
    expect(budget.state().committedUsd).toBeCloseTo(anthropicCost(model, usage.input_tokens, usage.output_tokens)!, 6);
    expect(budget.state().committedUsd).toBeLessThanOrEqual(0.084 + 1e-9);
  });

  it("is refused, and sends nothing, when the room is under its floor", async () => {
    const budget = memoryRunBudget("run-b", size.minUsd / 2, {});
    const out = await withSpendScope({ budget, stage: "buyer_fit" }, () => judgeBuyerFit(business, phrases, {}));
    expect(out.verdicts.size).toBe(0);
    expect(create).not.toHaveBeenCalled();
    expect(budget.state().committedUsd).toBe(0);
  });

  it("claims all or nothing for a caller that names no floor, as before", async () => {
    const budget = memoryRunBudget("run-c", 0.01, {});
    const raw = await withSpendScope({ budget, stage: "judge" }, () => askStructured("x", "y".repeat(1000), { maxTokens: 2000, tier: "decision" }));
    expect(raw).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("is sent with its ceiling outside a first look", async () => {
    await judgeBuyerFit(business, phrases, {});
    expect((create.mock.calls[0][0] as { max_tokens: number }).max_tokens).toBe(full.maxTokens);
  });

  it("cannot hold a run for half an hour: a bounded timeout and one retry", async () => {
    await askStructured("x", "y", { maxTokens: 10 });
    expect(clientOptions[0]).toMatchObject({ timeout: STRUCTURED_TIMEOUT_MS, maxRetries: STRUCTURED_MAX_RETRIES });
    expect(STRUCTURED_TIMEOUT_MS * (STRUCTURED_MAX_RETRIES + 1)).toBeLessThanOrEqual(240_000);
  });
});
