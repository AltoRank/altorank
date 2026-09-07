import { describe, it, expect } from "vitest";
import {
  FREE_DRAFTS,
  freeAllowanceUsedClause,
  freeAllowanceUsedMessage,
  quotaExceededMessage,
  type Quota,
} from "../quota";

// ---------------------------------------------------------------------------
// The 1 -> 7 drift, closed
// ---------------------------------------------------------------------------
//
// FREE_DRAFTS became 7 on 2026-09-06 and nine user-facing strings still said
// "the free draft"; one rendered "the free tier includes 7 draft". Every one of
// them now goes through these two functions or through `plural`, so the number
// and the grammar move with the constant.

const noPlan = (limit: number): Quota => ({
  limit,
  used: limit,
  remaining: 0,
  reason: "no-plan",
  plan: null,
});

describe("freeAllowanceUsedClause", () => {
  it("agrees its verb with the count", () => {
    expect(freeAllowanceUsedClause(1)).toBe("1 free draft is used");
    expect(freeAllowanceUsedClause(7)).toBe("7 free drafts are used");
    expect(freeAllowanceUsedClause(0)).toBe("0 free drafts are used");
  });

  it("defaults to the constant, not to a number typed into the string", () => {
    expect(freeAllowanceUsedClause()).toBe(freeAllowanceUsedClause(FREE_DRAFTS));
    expect(freeAllowanceUsedClause()).toContain(String(FREE_DRAFTS));
  });

  it("is a clause: no capital, no full stop, so it can be embedded", () => {
    const clause = freeAllowanceUsedClause(7);
    expect(clause[0]).toBe(clause[0].toLowerCase());
    expect(clause.endsWith(".")).toBe(false);
  });
});

describe("freeAllowanceUsedMessage", () => {
  it("is a sentence about the whole account, because the allowance is one-time", () => {
    // It said "This month's 7 free drafts are used" while the count refilled
    // on the 1st. Since migration 083 it does not, and "this month's" is a
    // promise about next month that nothing keeps.
    expect(freeAllowanceUsedMessage(7)).toBe("All 7 free drafts are used.");
    expect(freeAllowanceUsedMessage(1)).toBe("All 1 free draft is used.");
  });

  it("names no reset date anywhere on the free path", () => {
    expect(freeAllowanceUsedMessage(7)).not.toMatch(/month|reset|1st/i);
  });
});

describe("quotaExceededMessage", () => {
  it("never says 'the free draft' in the singular for a week's allowance", () => {
    const message = quotaExceededMessage(noPlan(FREE_DRAFTS));
    expect(message).not.toMatch(/the free draft is used/);
    expect(message).toContain(`${FREE_DRAFTS} free drafts are used`);
  });

  it("offers the two ways forward there actually are, and never a reset", () => {
    // There used to be three, the third being "wait for Oct 1, when the
    // allowance resets". The allowance is one-time now, so naming a date
    // would send someone away to wait for something that never arrives.
    const message = quotaExceededMessage(noPlan(FREE_DRAFTS), new Date("2026-09-06T00:00:00Z"));
    expect(message).toMatch(/Billing page/);
    expect(message).toMatch(/self-host/);
    expect(message).not.toMatch(/Oct 1|resets/);
  });

  it("leaves the paid branch quoting the plan's own volume", () => {
    const message = quotaExceededMessage({
      limit: 100,
      used: 100,
      remaining: 0,
      reason: "plan",
      plan: "starter",
    });
    expect(message).toContain("100 articles");
    expect(message).toMatch(/overage/);
    expect(message).not.toMatch(/free draft/);
  });
});
