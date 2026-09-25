import { describe, it, expect } from "vitest";
import { freeAllowanceClause } from "../copy";
import { FREE_DRAFTS } from "@/lib/billing/quota";
import { FREE_TIER_PACE } from "@/lib/content/pace";
import { buildPlan, PLAN_MAX_ENTRIES } from "../plan";

describe("freeAllowanceClause", () => {
  it("qualifies the thirty-day promise with what is actually free", () => {
    expect(freeAllowanceClause(7)).toBe("The first 7 are free to read; the 7-day trial writes the rest.");
    expect(freeAllowanceClause(1)).toBe("The first one is free to read; the 7-day trial writes the rest.");
  });

  // Before the trial nothing is readable (lib/billing/trial.ts,
  // draftBodyLocked): setup writes one article and the trial opens it.
  it("does not promise a readable draft to an account before its trial", () => {
    const clause = freeAllowanceClause(7, { preTrial: true });
    expect(clause).toBe("Setup writes your first article free; the 7-day trial opens it and writes the rest.");
    expect(clause).not.toMatch(/free to read/);
    expect(freeAllowanceClause(1, { preTrial: true })).toBe(clause);
    expect(freeAllowanceClause(null, { preTrial: true })).toBeNull();
  });

  it("says nothing for an account with nothing to qualify", () => {
    // Unmetered: self-host, operator, or an active plan.
    expect(freeAllowanceClause(null)).toBeNull();
    // Already spent: the calendar's own frozen reason speaks for that state.
    expect(freeAllowanceClause(0)).toBeNull();
  });

  /**
   * The reason the clause exists: at the free tier's pace the plan is more
   * than four times the entitlement, so the promise and the allowance really
   * do disagree and the wizard has to say which is which.
   */
  it("is needed: a free site's thirty-day plan outruns its free drafts", () => {
    const kws = Array.from({ length: PLAN_MAX_ENTRIES }, (_, i) => ({
      keywordId: `k${i}`,
      term: `term ${i}`,
      action: "write" as const,
      quality: "ok" as const,
    }));
    const plan = buildPlan(kws, { weeklyLimit: FREE_TIER_PACE, from: new Date("2026-09-07T00:00:00Z") });
    expect(plan.length).toBeGreaterThan(FREE_DRAFTS);
    expect(freeAllowanceClause(FREE_DRAFTS)).toContain(String(FREE_DRAFTS));
  });
});
