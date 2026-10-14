import { describe, it, expect, vi, beforeEach } from "vitest";
import { memoryRunBudget } from "@/lib/billing/run-budget";
import { withSpendScope } from "@/lib/billing/spend-scope";

// A writer the API refused before it started was billed nothing, and gives
// its whole grant back: kept committed, it left a first look no room to try
// the body again (round-1 review: a 400 held $0.36, the retry was refused for
// budget). One that failed part-way may have been billed, and keeps it.

const plan = vi.hoisted(() => ({ mode: "refused" as "refused" | "midway" | "offline" }));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      stream: () => ({
        [Symbol.asyncIterator]: async function* () {
          if (plan.mode === "refused") throw Object.assign(new Error("400 invalid_request_error"), { status: 400 });
          if (plan.mode === "offline") throw Object.assign(new Error("Connection error."), { status: undefined });
          yield { type: "message_start", message: { usage: { input_tokens: 9_000 } } };
          yield { type: "content_block_delta", delta: { type: "text_delta", text: "<p>part" } };
          throw Object.assign(new Error("529 overloaded"), { status: 529 });
        },
        finalMessage: async () => ({ stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } }),
      }),
    };
  },
}));

import { ClaudeProvider, unbilledRefusal } from "../claude";

async function write(): Promise<{ committed: number; error: unknown }> {
  const budget = memoryRunBudget("run-w", 1, {});
  let error: unknown = null;
  await withSpendScope({ budget, stage: "draft" }, async () => {
    try {
      const gen = new ClaudeProvider("claude-sonnet-5").streamArticle({ keyword: "acme kits" });
      while (!(await gen.next()).done) {
        // drain
      }
    } catch (e) {
      error = e;
    }
  });
  return { committed: budget.state().committedUsd, error };
}

describe("the writer's grant when the stream fails", () => {
  beforeEach(() => { plan.mode = "refused"; });

  it("is given back whole when the API refused before the stream started", async () => {
    const { committed, error } = await write();
    expect((error as { status?: number }).status).toBe(400);
    expect(committed).toBe(0);
  });

  it("stays committed when the stream failed part-way, or the connection never answered", async () => {
    plan.mode = "midway";
    expect((await write()).committed).toBeGreaterThan(0.3);
    plan.mode = "offline";
    expect((await write()).committed).toBeGreaterThan(0.3);
  });

  it("reads a refusal off the error's status", () => {
    expect(unbilledRefusal(Object.assign(new Error("x"), { status: 429 }))).toBe(true);
    expect(unbilledRefusal(Object.assign(new Error("x"), { status: undefined }))).toBe(false);
    expect(unbilledRefusal("400")).toBe(false);
  });
});
