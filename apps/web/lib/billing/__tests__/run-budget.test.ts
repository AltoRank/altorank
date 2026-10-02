import { describe, expect, it } from "vitest";
import { draftBudgetShort, FIRST_DRAFT_MIN_USD, FIRST_LOOK_CEILING_USD, firstLookCeiling, firstLookReserves } from "../run-budget";
import type { RunBudget } from "../spend-scope";

const roomOf = (room: number | null | "throws"): RunBudget => ({
  runId: "run-1",
  claim: async () => null,
  settle: async () => {},
  room: async () => {
    if (room === "throws") throw new Error("no row");
    return room;
  },
});

describe("a first look's ceiling", () => {
  it("is a dollar, the draft's and the swap's reserves inside it", () => {
    expect(firstLookCeiling({})).toBe(FIRST_LOOK_CEILING_USD);
    expect(FIRST_LOOK_CEILING_USD).toBe(1);
    expect(firstLookReserves()).toEqual({ draft: 0.3, outline_swap: 0.05 });
  });

  it("can be lowered for a proof run, never raised, and ignores what is not a positive number", () => {
    expect(firstLookCeiling({ FIRST_LOOK_BUDGET_USD: "0.5" })).toBe(0.5);
    expect(firstLookCeiling({ FIRST_LOOK_BUDGET_USD: "5" })).toBe(1);
    for (const junk of ["", "0", "-1", "abc"]) expect(firstLookCeiling({ FIRST_LOOK_BUDGET_USD: junk })).toBe(1);
  });
});

describe("whether a first draft can be started on what is left", () => {
  it("says why not when the draft stage's room is under the writer's floor", async () => {
    const short = await draftBudgetShort(roomOf(0.1));
    expect(short).toContain("has $0.10 left");
    expect(short).toContain(`about $${FIRST_DRAFT_MIN_USD.toFixed(2)}`);
  });

  it("lets it start when the room covers it, when there is no budget, or when the room cannot be read (the claims decide then)", async () => {
    expect(await draftBudgetShort(roomOf(FIRST_DRAFT_MIN_USD))).toBeNull();
    expect(await draftBudgetShort(null)).toBeNull();
    expect(await draftBudgetShort(roomOf(null))).toBeNull();
    expect(await draftBudgetShort(roomOf("throws"))).toBeNull();
  });
});
