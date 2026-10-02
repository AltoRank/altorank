import { afterEach, describe, expect, it, vi } from "vitest";
import {
  draftBudgetShort,
  DRAFT_RESEARCH_USD,
  FIRST_DRAFT_MIN_USD,
  FIRST_LOOK_CEILING_USD,
  FIRST_LOOK_DRAFT_RESERVE_USD,
  FIRST_LOOK_SWAP_RESERVE_USD,
  firstLookCeiling,
  firstLookReserves,
  loadDraftBudget,
  memoryRunBudget,
  openFirstLookBudget,
  RELATED_LOOKUP_USD,
  WRITER_MIN_OUTPUT_TOKENS,
  WRITER_PROMPT_USD,
} from "../run-budget";
import { anthropicOutputRate } from "../spend";
import type { RunBudget } from "../spend-scope";
import { estimateDataForSEOUsd } from "@/lib/seo/dataforseo-cost";

const roomOf = (room: number | null | "throws"): RunBudget => ({
  runId: "run-1",
  claim: async () => null,
  settle: async () => {},
  room: async () => {
    if (room === "throws") throw new Error("no row");
    return room;
  },
});

afterEach(() => vi.restoreAllMocks());

describe("a first look's ceiling", () => {
  it("is a dollar, the draft's and the swap's reserves inside it", () => {
    expect(firstLookCeiling({})).toBe(FIRST_LOOK_CEILING_USD);
    expect(FIRST_LOOK_CEILING_USD).toBe(1);
    expect(firstLookReserves()).toEqual({ draft: FIRST_LOOK_DRAFT_RESERVE_USD, outline_swap: FIRST_LOOK_SWAP_RESERVE_USD });
  });

  it("holds the draft what the writer's floor and the draft's own purchases cost, so the writer is not cut short", () => {
    // The writer runs on Sonnet 5; its floor clears the 24,000 tokens a live
    // run was cut off at (lib/ai/claude.ts).
    expect(WRITER_MIN_OUTPUT_TOKENS).toBeGreaterThan(24_000);
    const writerFloor = WRITER_PROMPT_USD + WRITER_MIN_OUTPUT_TOKENS * anthropicOutputRate("claude-sonnet-5");
    expect(FIRST_DRAFT_MIN_USD).toBeCloseTo(DRAFT_RESEARCH_USD + writerFloor, 2);
    // The related-keyword lookup is the draft's, bought once from its reserve.
    expect(RELATED_LOOKUP_USD).toBe(estimateDataForSEOUsd("/keywords_data/google_ads/keywords_for_keywords/live", [{}]));
    expect(FIRST_LOOK_DRAFT_RESERVE_USD).toBeCloseTo(FIRST_DRAFT_MIN_USD + RELATED_LOOKUP_USD, 2);
    // And research still has most of the dollar.
    expect(FIRST_LOOK_CEILING_USD - FIRST_LOOK_DRAFT_RESERVE_USD - FIRST_LOOK_SWAP_RESERVE_USD).toBeGreaterThan(0.5);
  });

  it("can be lowered for a proof run, never raised, and ignores what is not a positive number", () => {
    expect(firstLookCeiling({ FIRST_LOOK_BUDGET_USD: "0.5" })).toBe(0.5);
    expect(firstLookCeiling({ FIRST_LOOK_BUDGET_USD: "5" })).toBe(1);
    for (const junk of ["", "0", "-1", "abc"]) expect(firstLookCeiling({ FIRST_LOOK_BUDGET_USD: junk })).toBe(1);
  });

  it("keeps the reserves in proportion when a proof run lowers the ceiling", () => {
    const half = firstLookReserves(0.5);
    expect(half.draft).toBeCloseTo(FIRST_LOOK_DRAFT_RESERVE_USD / 2, 6);
    expect(half.outline_swap).toBeCloseTo(FIRST_LOOK_SWAP_RESERVE_USD / 2, 6);
    expect(firstLookReserves(5)).toEqual(firstLookReserves());
  });
});

describe("whether a first draft can be started on what is left", () => {
  it("says why not when the draft stage's room is under the writer's floor and the lookup", async () => {
    const short = await draftBudgetShort(roomOf(0.1));
    expect(short).toContain("has $0.10 left");
    expect(short).toContain(`about $${FIRST_LOOK_DRAFT_RESERVE_USD.toFixed(2)}`);
  });

  it("counts the related-keyword lookup only when the draft still has to buy it", async () => {
    expect(await draftBudgetShort(roomOf(FIRST_DRAFT_MIN_USD), { lookupBought: true })).toBeNull();
    expect(await draftBudgetShort(roomOf(FIRST_DRAFT_MIN_USD))).toContain(`about $${FIRST_LOOK_DRAFT_RESERVE_USD.toFixed(2)}`);
    expect(await draftBudgetShort(roomOf(FIRST_LOOK_DRAFT_RESERVE_USD))).toBeNull();
  });

  it("lets it start when there is no budget, or when the room cannot be read (the claims decide then)", async () => {
    expect(await draftBudgetShort(null)).toBeNull();
    expect(await draftBudgetShort(roomOf(null))).toBeNull();
    expect(await draftBudgetShort(roomOf("throws"))).toBeNull();
  });
});

describe("the budget in memory (migration 106's rules)", () => {
  it("holds each reserve for its own stage and never commits past the ceiling", async () => {
    const b = memoryRunBudget("run-m", 1, { draft: 0.4, outline_swap: 0.05 });
    expect(await b.room("judge")).toBeCloseTo(0.55, 6);
    expect(await b.claim("judge", 0.5, 0.5)).toBeCloseTo(0.5, 6);
    expect(await b.claim("judge", 0.1, 0.1)).toBeNull();
    expect(await b.claim("judge", 0.1, 0.01)).toBeCloseTo(0.05, 6);
    expect(await b.room("draft")).toBeCloseTo(0.4, 6);
    await b.settle("judge", 0.5, 0.3);
    expect(await b.room("draft")).toBeCloseTo(0.6, 6);
    const s = b.state();
    expect(s.committedUsd).toBeCloseTo(0.35, 6);
    expect(s.refused).toBe(1);
    expect(s.stages.judge).toMatchObject({ spent: 0.3, calls: 1, refused: 1 });
  });
});

/** A client whose run_budgets writes and reads fail, as on a database without migration 106. */
const brokenDb = (calls: { upserts: number }) =>
  ({
    from: () => ({
      upsert: async () => { calls.upserts++; return { error: { message: 'relation "public.run_budgets" does not exist' } }; },
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "relation does not exist" } }) }) }),
    }),
    rpc: async () => ({ data: null, error: { message: "function does not exist" } }),
  }) as never;

describe("a budget row that cannot be written", () => {
  it("is tried twice, then the run is bounded in memory with the same ceiling and reserves: never unbounded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = { upserts: 0 };
    const { budget, read } = await openFirstLookBudget(brokenDb(calls), { runId: "run-x", workspaceId: "ws" });
    expect(calls.upserts).toBe(2);
    expect(await budget.room("judge")).toBeCloseTo(FIRST_LOOK_CEILING_USD - FIRST_LOOK_DRAFT_RESERVE_USD - FIRST_LOOK_SWAP_RESERVE_USD, 6);
    expect(await budget.claim("judge", 0.9, 0.9)).toBeNull();
    expect((await read())?.refused).toBe(1);
  });

  it("holds the draft route to the draft's reserve when there is no row to read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const budget = await loadDraftBudget(brokenDb({ upserts: 0 }), "run-y");
    expect(await budget.room("draft")).toBeCloseTo(FIRST_LOOK_DRAFT_RESERVE_USD, 6);
    expect(await budget.claim("draft", 1, 1)).toBeNull();
  });
});

describe("DataForSEO estimates against what was billed", () => {
  // Bills seen on the proof runs of 2026-10-01: an estimate under the bill
  // lets a run's total pass its ceiling by the gap.
  it("sits at or above every observed backlinks bill", () => {
    expect(estimateDataForSEOUsd("/backlinks/summary/live", [{ target: "acme-site.example" }])).toBeGreaterThanOrEqual(0.024036);
    expect(estimateDataForSEOUsd("/backlinks/backlinks/live", [{ target: "acme-site.example", limit: 200 }])).toBeGreaterThanOrEqual(0.031056);
  });
});
