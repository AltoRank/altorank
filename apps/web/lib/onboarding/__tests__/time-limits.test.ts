// ---------------------------------------------------------------------------
// Every wait of a first look has an end: the bounds, the calls that use them
// ---------------------------------------------------------------------------
//
// A real signup's re-run (2026-10-15) sat in qualification for 25 minutes on
// calls whose answers never came. Each test here is a call that never
// answers, on the real code path, with the bounds shortened.

import { describe, expect, it, vi } from "vitest";

const real = await vi.importActual<typeof import("../time-limits")>("../time-limits");
vi.mock("../time-limits", () => ({ BUDGET_RPC_TIMEOUT_MS: 40, STRUCTURED_CALL_DEADLINE_MS: 60, METERED_CALL_DEADLINE_MS: 60, FIRST_LOOK_QUALIFY_MS: 500 }));

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));
vi.mock("@/lib/billing/default-spend", () => ({ recordSpendByDefault: vi.fn(), spendClient: () => null }));

import { askStructured, STRUCTURED_MAX_RETRIES, STRUCTURED_TIMEOUT_MS } from "@/lib/keyword-research/buyer-model";
import { createMetered } from "@/lib/ai/metered";
import { memoryRunBudget, runBudget } from "@/lib/billing/run-budget";
import { BudgetRefusedError, claimSpend, withSpendScope } from "@/lib/billing/spend-scope";

/** What the SDK throws when the request's own signal aborts it. */
const aborted = () => Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" });
/** A model call whose reply never comes: it ends only when its signal aborts. */
const silent = (_p: unknown, options?: { signal?: AbortSignal }) => new Promise((_, reject) => {
  options?.signal?.addEventListener("abort", () => reject(aborted()), { once: true });
});

describe("the bounds", () => {
  it("cover what they bound, and fit a first look inside the worker's 300 seconds", () => {
    // Both attempts the SDK makes, and its backoff between them.
    expect(real.STRUCTURED_CALL_DEADLINE_MS).toBeGreaterThan(STRUCTURED_TIMEOUT_MS * (STRUCTURED_MAX_RETRIES + 1));
    expect(real.FIRST_LOOK_QUALIFY_MS).toBeLessThan(300_000);
    expect(real.BUDGET_RPC_TIMEOUT_MS).toBeLessThan(real.FIRST_LOOK_QUALIFY_MS / 4);
  });
});

describe("a run-budget RPC whose answer never comes", () => {
  /** A PostgREST builder that answers only when its abort signal fires, with the error PostgREST returns then. */
  const silentDb = (signals: AbortSignal[]) => ({
    rpc: () => {
      let signal: AbortSignal | undefined;
      const builder = {
        abortSignal(s: AbortSignal) { signal = s; signals.push(s); return builder; },
        then(resolve: (v: unknown) => unknown) {
          signal?.addEventListener("abort", () => resolve({ data: null, error: { message: "AbortError: This operation was aborted" } }), { once: true });
        },
      };
      return builder;
    },
  }) as never;

  it("ends at its bound: a claim is refused, a settle leaves its claim at the estimate, a room is unread", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const signals: AbortSignal[] = [];
    const budget = runBudget(silentDb(signals), "run-1");
    const started = Date.now();
    await expect(budget.claim("judge", 0.02, 0.01)).rejects.toThrow(/abort/i);
    await expect(budget.settle("judge", 0.02, 0.01)).rejects.toThrow(/abort/i);
    expect(await budget.room("judge")).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(signals).toHaveLength(3);
    // As the paid calls see it: refused, nothing bought.
    await expect(withSpendScope({ budget }, () => claimSpend("op", 0.02))).rejects.toBeInstanceOf(BudgetRefusedError);
  });
});

describe("a structured model call whose reply never comes", () => {
  it("is aborted at its deadline, is no decision, and settles its claim at the estimate", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    create.mockReset();
    create.mockImplementation(silent);
    const budget = memoryRunBudget("run-1", 1, {});
    const started = Date.now();
    const raw = await withSpendScope({ budget, stage: "judge" }, () => askStructured("keyword-research/opportunity", "prompt", { maxTokens: 800, minTokens: 400, tier: "decision" }));
    expect(raw).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    // Settled - the room is not held by a call that ended - at the estimate,
    // since an aborted request may still have been billed.
    const judge = budget.state().stages.judge!;
    expect(judge.calls).toBe(1);
    expect(judge.spent).toBeGreaterThan(0);
    expect(judge.committed).toBeCloseTo(judge.spent!, 9);
    vi.unstubAllEnvs();
  });

  it("returns its answer and settles at its cost when the spend row never writes", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    create.mockReset();
    create.mockResolvedValue({ content: [{ type: "text", text: "{\"ok\":true}" }], usage: { input_tokens: 1000, output_tokens: 100 } });
    const stuck = { from: () => ({ insert: () => new Promise(() => {}) }) } as never;
    const budget = memoryRunBudget("run-1", 1, {});
    const raw = await withSpendScope({ budget, stage: "judge" }, () => askStructured("keyword-research/opportunity", "prompt", { maxTokens: 800, tier: "decision", spend: { supabase: stuck, workspaceId: "ws" } }));
    expect(raw).toBe("{\"ok\":true}");
    expect(budget.state().stages.judge?.calls).toBe(1);
    expect(budget.state().committedUsd).toBeLessThan(0.01);
    vi.unstubAllEnvs();
  });
});

describe("a metered model call whose reply never comes (the voice read the plan waits for)", () => {
  it("is aborted at its deadline and settles its claim at the estimate", async () => {
    const client = { messages: { create: vi.fn(silent) } } as never;
    const budget = memoryRunBudget("run-1", 1, {});
    const started = Date.now();
    await expect(withSpendScope({ budget, stage: "voice" }, () => createMetered(client, { model: "claude-sonnet-5", max_tokens: 100, messages: [{ role: "user", content: "x" }] }, "voice"))).rejects.toMatchObject({ name: "APIUserAbortError" });
    expect(Date.now() - started).toBeLessThan(1_000);
    const voice = budget.state().stages.voice!;
    expect(voice.calls).toBe(1);
    expect(voice.committed).toBeGreaterThan(0);
  });
});
