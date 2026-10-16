import { describe, it, expect, vi, beforeEach } from "vitest";
import { memoryRunBudget } from "@/lib/billing/run-budget";
import { withSpendScope } from "@/lib/billing/spend-scope";

// The writer ends at its deadline, whatever the stream does. The SDK clears
// its own timeout once the response headers arrive, so a stream that stalls
// after them used to be waited on until the platform killed the function.
// The stand-in below stalls and never notices the signal: only the writer's
// own wait can end it.

const plan = vi.hoisted(() => ({
  mode: "stall" as "stall" | "whole",
  aborted: 0,
  signal: null as AbortSignal | null,
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      stream: (_params: unknown, options?: { signal?: AbortSignal }) => {
        plan.signal = options?.signal ?? null;
        return {
          abort: () => { plan.aborted += 1; },
          [Symbol.asyncIterator]: async function* () {
            yield { type: "message_start", message: { usage: { input_tokens: 9_000 } } };
            yield { type: "content_block_delta", delta: { type: "text_delta", text: "<h1>Acme kits</h1><p>half an" } };
            if (plan.mode === "stall") await new Promise(() => undefined);
            yield { type: "content_block_delta", delta: { type: "text_delta", text: " article.</p>" } };
            yield { type: "message_delta", usage: { output_tokens: 1_200 } };
          },
          finalMessage: async () => ({ stop_reason: "end_turn", usage: { input_tokens: 9_000, output_tokens: 1_200 } }),
        };
      },
    };
  },
}));

import { ClaudeProvider, GenerationTimedOutError } from "../claude";

async function write(signal?: AbortSignal) {
  const budget = memoryRunBudget("run-d", 1, {});
  const chunks: string[] = [];
  let error: unknown = null;
  let result: unknown = null;
  const started = Date.now();
  await withSpendScope({ budget, stage: "draft" }, async () => {
    try {
      const gen = new ClaudeProvider("claude-sonnet-5").streamArticle({ keyword: "acme kits" }, signal ? { signal } : {});
      while (true) {
        const next = await gen.next();
        if (next.done) { result = next.value; break; }
        chunks.push(next.value);
      }
    } catch (e) {
      error = e;
    }
  });
  return { budget: budget.state(), chunks, error, result, ms: Date.now() - started };
}

describe("the writer's deadline", () => {
  beforeEach(() => {
    plan.mode = "stall";
    plan.aborted = 0;
    plan.signal = null;
  });

  it("ends a stream that stalls for ever at the deadline, aborts the request, and keeps the claim at its estimate", async () => {
    const { error, ms, budget, chunks } = await write(AbortSignal.timeout(150));
    expect(error).toBeInstanceOf(GenerationTimedOutError);
    expect((error as GenerationTimedOutError).chars).toBeGreaterThan(0);
    expect((error as Error).message).toMatch(/nothing it wrote was kept/);
    expect(ms).toBeLessThan(2_000);
    // The request is sent with the deadline and aborted when it passes.
    expect(plan.signal?.aborted).toBe(true);
    expect(plan.aborted).toBe(1);
    // Settled at its estimate: it may have been billed for what it wrote.
    expect(budget.committedUsd).toBeGreaterThan(0.3);
    // What streamed before the stall reached the caller, but no result did.
    expect(chunks.join("")).toContain("half an");
  });

  it("claims nothing for a writer whose time is already up", async () => {
    const { error, budget } = await write(AbortSignal.abort());
    expect(error).toBeInstanceOf(GenerationTimedOutError);
    expect(budget.committedUsd).toBe(0);
    expect(plan.signal).toBeNull();
  });

  it("writes the whole article as before when it finishes in time", async () => {
    plan.mode = "whole";
    const { error, result, budget } = await write(AbortSignal.timeout(5_000));
    expect(error).toBeNull();
    expect(result).toMatchObject({ title: "Acme kits", inputTokens: 9_000, outputTokens: 1_200 });
    expect(plan.aborted).toBe(0);
    // Settled at what it cost, well under the grant.
    expect(budget.committedUsd).toBeGreaterThan(0);
    expect(budget.committedUsd).toBeLessThan(0.1);
  });
});
