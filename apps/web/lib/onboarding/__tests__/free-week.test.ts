import { describe, it, expect } from "vitest";
import { buildPlan, PLAN_MAX_ENTRIES } from "../plan";
import { FREE_TIER_PACE, PAID_DEFAULT_PACE } from "@/lib/content/pace";
import { FREE_DRAFTS } from "@/lib/billing/quota";

const kws = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    keywordId: `k${i}`,
    term: `term ${i}`,
    action: "write" as const,
    quality: "ok" as const,
  }));

describe("the free week", () => {
  const from = new Date("2026-09-07T00:00:00Z"); // a Monday

  it("plans seven articles in the first seven days for a free site", () => {
    const plan = buildPlan(kws(30), { weeklyLimit: FREE_TIER_PACE, from });
    const week = plan.filter((p) => p.date < "2026-09-14");
    expect(week).toHaveLength(7);
  });

  it("plans a full thirty days for a paid site at the paid pace", () => {
    const plan = buildPlan(kws(PLAN_MAX_ENTRIES), { weeklyLimit: PAID_DEFAULT_PACE, from });
    expect(plan.length).toBeGreaterThanOrEqual(28);
    expect(plan.every((p) => p.date >= "2026-09-07")).toBe(true);
  });

  it("the free entitlement covers exactly the week the plan schedules", () => {
    const week = buildPlan(kws(30), { weeklyLimit: FREE_TIER_PACE, from }).filter((p) => p.date < "2026-09-14");
    expect(week).toHaveLength(FREE_DRAFTS);
  });
});
