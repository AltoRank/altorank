import { describe, it, expect } from "vitest";
import { freeAllowanceClause, wizardNextLine, FIRST_LOOK_MINUTES } from "../copy";
import { fullArticleOn } from "../first-article-body";
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

// The wizard bar promised "keywords, a 30-day plan" and "your first article
// free", and the gate then showed one scheduled article behind a lock (UX
// audit 2026-10-12, #5). It says only what the next minutes deliver.
describe("wizardNextLine", () => {
  it("promises no 30-day plan to anyone", () => {
    for (const preTrial of [true, false]) {
      for (const canRead of [true, false]) {
        for (const freeDrafts of [null, 1, 7]) {
          const { full, short } = wizardNextLine({ preTrial, canRead, freeDrafts });
          expect(full + short).not.toMatch(/30-day|thirty|month/i);
          expect(full).toContain(`about ${FIRST_LOOK_MINUTES} minutes`);
        }
      }
    }
  });

  it("says the article is free to read only to someone who can read it before the trial", () => {
    const owner = wizardNextLine({ preTrial: true, canRead: true, freeDrafts: 1 });
    expect(owner.full).toBe(
      "Next: we read your site, pick your first topic and write your first article while you watch, in about 3 minutes. Read it free; the 7-day trial lets you publish it and writes the rest.",
    );
    expect(owner.short).toBe("About 3 minutes. Read your first article free.");
    const member = wizardNextLine({ preTrial: true, canRead: false, freeDrafts: 1 });
    expect(member.full + member.short).not.toMatch(/free/i);
    expect(member.full).toContain("The 7-day trial opens it");
  });

  it("is on by default: the owner can read it unless the switch is set to 0", () => {
    expect(fullArticleOn({})).toBe(true);
  });

  it("keeps the phone line short", () => {
    for (const preTrial of [true, false]) for (const canRead of [true, false]) {
      expect(wizardNextLine({ preTrial, canRead, freeDrafts: null }).short.length).toBeLessThanOrEqual(60);
    }
  });
});
