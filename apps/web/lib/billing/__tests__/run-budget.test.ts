import { afterEach, describe, expect, it, vi } from "vitest";
import {
  draftBudgetShort,
  draftCanBuyLookup,
  DRAFT_RESEARCH_USD,
  FIRST_DRAFT_MIN_USD,
  FIRST_LOOK_CEILING_USD,
  FIRST_LOOK_DRAFT_RESERVE_USD,
  FIRST_LOOK_SWAP_RESERVE_USD,
  firstLookCeiling,
  firstLookReserves,
  firstLookResearchLeave,
  FIRST_LOOK_BUYER_TEST_ROOM_USD,
  FIRST_LOOK_QUALIFY_ROOM_USD,
  leavingRoom,
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

  it("holds the draft what its writer's floor, prompt and research cost, so the writer is not cut short", () => {
    // The writer runs on Sonnet 5; its floor clears the 24,000 tokens a live
    // run was cut off at (lib/ai/claude.ts).
    expect(WRITER_MIN_OUTPUT_TOKENS).toBeGreaterThan(24_000);
    const writerFloor = WRITER_PROMPT_USD + WRITER_MIN_OUTPUT_TOKENS * anthropicOutputRate("claude-sonnet-5");
    expect(FIRST_DRAFT_MIN_USD).toBeCloseTo(DRAFT_RESEARCH_USD + writerFloor, 2);
    expect(FIRST_LOOK_DRAFT_RESERVE_USD).toBe(FIRST_DRAFT_MIN_USD);
    // The related-keyword lookup is priced as DataForSEO bills it, and is not
    // in the reserve: it is bought only from room above it.
    expect(RELATED_LOOKUP_USD).toBe(estimateDataForSEOUsd("/keywords_data/google_ads/keywords_for_keywords/live", [{}]));
    // Research keeps most of the dollar: the plan is what a first look is for.
    expect(FIRST_LOOK_CEILING_USD - FIRST_LOOK_DRAFT_RESERVE_USD - FIRST_LOOK_SWAP_RESERVE_USD).toBeGreaterThanOrEqual(0.6);
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
  it("says why not when the draft stage's room is under the writer's floor", async () => {
    const short = await draftBudgetShort(roomOf(0.1));
    expect(short).toContain("has $0.10 left");
    expect(short).toContain(`about $${FIRST_DRAFT_MIN_USD.toFixed(2)}`);
    expect(await draftBudgetShort(roomOf(FIRST_DRAFT_MIN_USD))).toBeNull();
  });

  it("buys the related keywords only from room above what the writer needs", async () => {
    expect(await draftCanBuyLookup(roomOf(FIRST_DRAFT_MIN_USD))).toBe(false);
    expect(await draftCanBuyLookup(roomOf(FIRST_DRAFT_MIN_USD + RELATED_LOOKUP_USD))).toBe(true);
    expect(await draftCanBuyLookup(roomOf(null))).toBe(false);
    expect(await draftCanBuyLookup(null)).toBe(true);
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

describe("the keyword research leaves qualification its room", () => {
  // A production first look (2026-10-15): discovery $0.35 and the buyer test
  // $0.22 of the ~$0.67 research may use, leaving $0.08 to judge results
  // pages with - under one term - and nothing was planned.
  const RESEARCH = 1 - FIRST_LOOK_DRAFT_RESERVE_USD - FIRST_LOOK_SWAP_RESERVE_USD;
  const leave = firstLookResearchLeave();

  it("holds qualification's room from the buyer test, and the buyer test's as well from discovery", () => {
    expect(leave("buyer_fit")).toBeCloseTo(FIRST_LOOK_QUALIFY_ROOM_USD, 6);
    expect(leave("discovery")).toBeCloseTo(FIRST_LOOK_QUALIFY_ROOM_USD + FIRST_LOOK_BUYER_TEST_ROOM_USD, 6);
    // Discovery still has more than the $0.35 the run above spent.
    expect(RESEARCH - leave("discovery")).toBeGreaterThan(0.35);
    // A lowered proof ceiling keeps the proportion.
    expect(firstLookResearchLeave(0.5)("buyer_fit")).toBeCloseTo(FIRST_LOOK_QUALIFY_ROOM_USD / 2, 6);
  });

  it("grants research up to the room less what it leaves, refuses under the floor, and qualification then has its room", async () => {
    const row = memoryRunBudget("run-1", 1, firstLookReserves(1));
    const research = leavingRoom(row, leave);
    expect(await research.claim("discovery", 0.351, 0.351)).toBeCloseTo(0.351, 6);
    // The buyer test may use what is left above qualification's room.
    const usable = RESEARCH - 0.351 - FIRST_LOOK_QUALIFY_ROOM_USD;
    expect(await research.room("buyer_fit")).toBeCloseTo(usable, 6);
    expect(await research.claim("buyer_fit", 1, 0.05)).toBeCloseTo(usable, 6);
    expect(await research.claim("buyer_fit", 0.05, 0.05)).toBeNull();
    // Nothing was taken from qualification: the row itself still has it.
    expect(await row.room("judge")).toBeCloseTo(FIRST_LOOK_QUALIFY_ROOM_USD, 6);
    expect(await row.claim("judge", 0.1, 0.1)).toBeCloseTo(0.1, 6);
  });

  it("takes turns, so claims made side by side cannot both use the same margin", async () => {
    const row = memoryRunBudget("run-2", 0.3, {});
    // A row whose reads and claims each take a moment, as the database's do.
    const slow: RunBudget = {
      ...row,
      claim: async (...a) => { await new Promise((r) => setTimeout(r, 3)); return row.claim(...a); },
      room: async (st) => { await new Promise((r) => setTimeout(r, 3)); return row.room(st); },
    };
    const research = leavingRoom(slow, () => 0.1);
    const grants = await Promise.all(Array.from({ length: 5 }, () => research.claim("buyer_fit", 0.08, 0.08)));
    expect(grants.filter((g) => g !== null)).toHaveLength(2);
    expect(row.state().committedUsd).toBeCloseTo(0.16, 6);
    expect(await row.room("judge")).toBeGreaterThanOrEqual(0.1 - 1e-9);
  });

  it("leaves the claim to decide when the room cannot be read, and passes settles through", async () => {
    const row = memoryRunBudget("run-3", 0.2, {});
    const research = leavingRoom({ ...row, room: async () => null }, () => 0.15);
    expect(await research.claim("discovery", 0.1, 0.1)).toBeCloseTo(0.1, 6);
    await research.settle("discovery", 0.1, 0.02);
    expect(row.state().committedUsd).toBeCloseTo(0.02, 6);
    expect(research.runId).toBe("run-3");
  });
});

