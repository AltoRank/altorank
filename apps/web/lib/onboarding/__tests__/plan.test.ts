import { describe, it, expect } from "vitest";
import { buildPlan, PLAN_MAX_ENTRIES } from "../plan";

const rec = (i: number, over: Partial<{ action: "write" | "refresh" | "skip"; quality: "ok" | "suspect" }> = {}) => ({
  keywordId: `k${i}`,
  term: `term ${i}`,
  action: "write" as const,
  quality: "ok" as const,
  ...over,
});
const many = (n: number) => Array.from({ length: n }, (_, i) => rec(i));
const from = new Date("2026-09-04T15:00:00Z");

describe("buildPlan", () => {
  it("schedules one a day at 7/week, starting today", () => {
    const plan = buildPlan(many(60), { weeklyLimit: 7, from });
    expect(plan).toHaveLength(PLAN_MAX_ENTRIES);
    expect(plan[0].date).toBe("2026-09-04");
    expect(plan[1].date).toBe("2026-09-05");
    expect(plan[29].date).toBe("2026-10-03");
  });
  it("spaces a weekly pace seven days apart", () => {
    const plan = buildPlan(many(60), { weeklyLimit: 1, from });
    expect(plan.map((p) => p.date)).toEqual(["2026-09-04", "2026-09-11", "2026-09-18", "2026-09-25", "2026-10-02"]);
  });
  it("spreads two a week evenly rather than front-loading", () => {
    const plan = buildPlan(many(60), { weeklyLimit: 2, from });
    expect(plan.slice(0, 3).map((p) => p.date)).toEqual(["2026-09-04", "2026-09-08", "2026-09-11"]);
  });
  it("skips refresh, skip and suspect keywords", () => {
    const plan = buildPlan([rec(0, { action: "refresh" }), rec(1, { quality: "suspect" }), rec(2)], { weeklyLimit: 7, from });
    expect(plan.map((p) => p.keywordId)).toEqual(["k2"]);
  });
  it("returns nothing for a paused pace", () => {
    expect(buildPlan(many(10), { weeklyLimit: 0, from })).toEqual([]);
  });
  it("never plans more than the queue holds", () => {
    expect(buildPlan(many(3), { weeklyLimit: 7, from })).toHaveLength(3);
  });
});
