// ---------------------------------------------------------------------------
// The results judge's instructions are cached, and the text it reads is not changed
// ---------------------------------------------------------------------------
//
// Every judge read of a first look sends the same ~2,000 tokens of
// instructions ahead of its own results page, and a first look makes 15-25
// of them (2026-10-15 token profile). The instructions go as their own block
// marked for the prompt cache, so reads after the first pay a tenth for them.
// The model reads the same text, split in two: the stored eval answers, keyed
// by the prompt, still replay.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));
vi.mock("@/lib/billing/default-spend", () => ({ recordSpendByDefault: vi.fn(), spendClient: () => null }));

import { askStructured, firstCallAlone, promptContent, type AskModel } from "../buyer-model";
import { askResultsJudge, judgeCachePrefix, opportunityPrompt, type OpportunityContext } from "../opportunity";
import { anthropicModel } from "@/lib/ai/models";
import { anthropicCost } from "@/lib/billing/spend";

const context: OpportunityContext = {
  domain: "acme.example",
  languageCode: "en",
  locationCode: 2826,
  business: { name: "Acme Plumbing", description: "Acme Plumbing services boilers in Leeds.\nFamily-run since 1990.", offerings: ["boiler service"], audiences: ["homeowners in Leeds"] },
} as OpportunityContext;
const verdict = { keep: true as const, reason: "A homeowner with a boiler.", funnel: "buyer" as const };
const organic = (term: string) => Array.from({ length: 10 }, (_, i) => ({ url: `https://site-${i}.example/${encodeURIComponent(term)}`, title: `${term} guide ${i}`, description: `How ${term} works.\nLine two.` }));
const input = (term: string) => ({ term, context, verdict, organic: organic(term) });

beforeEach(() => {
  create.mockReset();
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  create.mockResolvedValue({ content: [{ type: "text", text: "{}" }], usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000 } });
});

describe("the judge's cached instructions", () => {
  it("end where the per-term data begins, and are the same for every term of a run", () => {
    const a = opportunityPrompt({ ...input("boiler service cost"), today: "2026-10-15" });
    const b = opportunityPrompt({ ...input("how often service a boiler"), today: "2026-10-15" });
    const cutA = judgeCachePrefix(a);
    const cutB = judgeCachePrefix(b);
    expect(a.slice(0, cutA)).toBe(b.slice(0, cutB));
    // The data is one JSON line: newlines inside the business or a snippet are escaped.
    expect(a.slice(cutA)).not.toContain("\n");
    expect(JSON.parse(a.slice(cutA)).query).toBe("boiler service cost");
    // Long enough to be cached (Sonnet's minimum is 1,024 tokens).
    expect(cutA / 4).toBeGreaterThan(1_024);
  });

  it("are sent as a cached block, and the two blocks are the prompt unchanged", async () => {
    await askResultsJudge(input("boiler service cost"), { today: "2026-10-15" });
    const sent = create.mock.calls[0][0] as { messages: Array<{ content: Array<{ text: string; cache_control?: unknown }> }> };
    const blocks = sent.messages[0].content;
    expect(blocks).toHaveLength(2);
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[1].cache_control).toBeUndefined();
    expect(blocks.map((b) => b.text).join("")).toBe(opportunityPrompt({ ...input("boiler service cost"), today: "2026-10-15" }));
  });

  it("leave a prompt without a prefix as one string", () => {
    expect(promptContent("abc")).toBe("abc");
    expect(promptContent("abc", 0)).toBe("abc");
    expect(promptContent("abc", 3)).toBe("abc");
  });

  it("are billed at what the cache made of them", async () => {
    const model = anthropicModel("decision");
    // 1,000 uncached in, 2,000 read from the cache, 200 out.
    expect(anthropicCost(model, 1000, 200, { readTokens: 2000 })).toBeCloseTo(anthropicCost(model, 1000 + 200, 200)!, 9);
    // Written: a quarter more than plain input.
    expect(anthropicCost(model, 0, 0, { writeTokens: 1000 })).toBeCloseTo(anthropicCost(model, 1250, 0)!, 9);
    await askStructured("op", "prompt", { maxTokens: 100, cachePrefix: 3 });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("the first judge read of a batch", () => {
  it("goes alone: the reads that come while it is out wait for its answer", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const inner: AskModel = async (_op, prompt) => {
      order.push(`start ${prompt}`);
      if (prompt === "a") await gate;
      order.push(`end ${prompt}`);
      return prompt;
    };
    const ask = firstCallAlone(inner);
    const all = Promise.all(["a", "b", "c"].map((p) => ask("op", p, { maxTokens: 1 })));
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(["start a"]);
    release();
    expect(await all).toEqual(["a", "b", "c"]);
    expect(order.slice(0, 2)).toEqual(["start a", "end a"]);
  });

  it("does not hold the rest when it fails", async () => {
    const ask = firstCallAlone(async (_op, prompt) => { if (prompt === "a") throw new Error("down"); return prompt; });
    const first = ask("op", "a", { maxTokens: 1 });
    const second = ask("op", "b", { maxTokens: 1 });
    await expect(first).rejects.toThrow("down");
    expect(await second).toBe("b");
  });
});
