import { describe, it, expect } from "vitest";
import { buildPlan, diffPlan, describePlanDiff, monthlyTarget, PLAN_HORIZON_DAYS, PLAN_MAX_ENTRIES } from "../plan";
import { nextOpenDates, SCHEDULE_CAP } from "../plan";

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
  it("schedules one a day at 7/week, starting today, for the whole horizon", () => {
    const plan = buildPlan(many(80), { weeklyLimit: 7, from });
    expect(plan).toHaveLength(PLAN_HORIZON_DAYS);
    expect(plan[0].date).toBe("2026-09-04");
    expect(plan[1].date).toBe("2026-09-05");
    expect(plan[29].date).toBe("2026-10-03");
  });
  it("never exceeds the hard cap, whatever the horizon", () => {
    const plan = buildPlan(many(200), { weeklyLimit: 7, from, horizonDays: 120 });
    expect(plan).toHaveLength(PLAN_MAX_ENTRIES);
    expect(PLAN_MAX_ENTRIES).toBe(60);
  });
  it("respects the room a caller has left under the cap", () => {
    expect(buildPlan(many(80), { weeklyLimit: 7, from, maxEntries: 4 })).toHaveLength(4);
    expect(buildPlan(many(80), { weeklyLimit: 7, from, maxEntries: 0 })).toEqual([]);
    // Asking for more than the cap still gets the cap.
    expect(buildPlan(many(200), { weeklyLimit: 7, from, horizonDays: 120, maxEntries: 500 })).toHaveLength(PLAN_MAX_ENTRIES);
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

describe("monthlyTarget", () => {
  it("is what a month at the pace should hold, capped", () => {
    expect(monthlyTarget(7)).toBe(30);
    expect(monthlyTarget(1)).toBe(5);
    expect(monthlyTarget(3)).toBe(13);
    expect(monthlyTarget(0)).toBe(0);
    // A pace above 7 is clamped like buildPlan clamps it.
    expect(monthlyTarget(25)).toBe(30);
  });
});

describe("nextOpenDates", () => {
  it("fills one a day from today at 7/week, skipping days already planned", () => {
    expect(nextOpenDates(["2026-09-05"], 7, 3, from)).toEqual(["2026-09-04", "2026-09-06", "2026-09-07"]);
  });
  it("keeps the weekly grid at 1/week", () => {
    expect(nextOpenDates([], 1, 3, from)).toEqual(["2026-09-04", "2026-09-11", "2026-09-18"]);
    expect(nextOpenDates(["2026-09-04"], 1, 2, from)).toEqual(["2026-09-11", "2026-09-18"]);
  });
  it("never returns a date twice, even when asked for more than one at once", () => {
    const dates = nextOpenDates([], 3, 10, from);
    expect(new Set(dates).size).toBe(10);
  });
  it("returns nothing for a paused pace or a zero count", () => {
    expect(nextOpenDates([], 0, 5, from)).toEqual([]);
    expect(nextOpenDates([], 7, 0, from)).toEqual([]);
  });
  it("the cap is the competitor-verified 60", () => {
    expect(SCHEDULE_CAP).toBe(60);
  });
});

describe("buildPlan with publishing days", () => {
  // 2026-09-04 is a Friday.
  const weekdays = [1, 2, 3, 4, 5];
  const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

  it("puts every entry on a chosen weekday", () => {
    const plan = buildPlan(many(60), { weeklyLimit: 7, from, daysOfWeek: weekdays });
    expect(plan.length).toBeGreaterThan(0);
    for (const p of plan) expect(weekdays).toContain(dow(p.date));
  });
  it("one a week on Mondays only lands on Mondays, first one next Monday", () => {
    const plan = buildPlan(many(60), { weeklyLimit: 1, from, daysOfWeek: [1] });
    expect(plan.map((p) => p.date)).toEqual(["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"]);
  });
  it("spreads three a week over Mon/Wed/Fri as Fri, Mon, Wed", () => {
    const plan = buildPlan(many(60), { weeklyLimit: 3, from, daysOfWeek: [1, 3, 5] });
    expect(plan.slice(0, 4).map((p) => p.date)).toEqual(["2026-09-04", "2026-09-07", "2026-09-09", "2026-09-11"]);
  });
  it("doubles up when the pace exceeds the chosen days rather than spilling onto other days", () => {
    const plan = buildPlan(many(60), { weeklyLimit: 7, from, daysOfWeek: [1, 3] });
    const week2 = plan.filter((p) => p.date >= "2026-09-11" && p.date <= "2026-09-17");
    const byDay = new Map<string, number>();
    for (const p of week2) byDay.set(p.date, (byDay.get(p.date) ?? 0) + 1);
    expect([...byDay.keys()].sort()).toEqual(["2026-09-14", "2026-09-16"]);
    expect([...byDay.values()].reduce((a, b) => a + b, 0)).toBe(7);
  });
  it("keeps the old behaviour when no days are given or none are valid", () => {
    const plain = buildPlan(many(60), { weeklyLimit: 2, from });
    expect(buildPlan(many(60), { weeklyLimit: 2, from, daysOfWeek: [] })).toEqual(plain);
    expect(buildPlan(many(60), { weeklyLimit: 2, from, daysOfWeek: [9, -1] })).toEqual(plain);
  });
  it("stays within the horizon and the entry cap", () => {
    const plan = buildPlan(many(100), { weeklyLimit: 7, from, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] });
    // The cap is 60 (#67) but a 30-day horizon at 7/week holds 30; the
    // horizon is the binding limit here, not the cap.
    expect(plan).toHaveLength(Math.min(PLAN_MAX_ENTRIES, PLAN_HORIZON_DAYS));
    expect(plan[plan.length - 1].date <= "2026-10-03").toBe(true);
  });
});

describe("diffPlan", () => {
  const e = (id: string, date: string) => ({ keywordId: id, date });
  it("counts kept, moved, added and removed keywords", () => {
    const before = [e("a", "2026-09-04"), e("b", "2026-09-08"), e("c", "2026-09-11")];
    const after = [e("a", "2026-09-04"), e("b", "2026-09-05"), e("d", "2026-09-06")];
    expect(diffPlan(before, after)).toEqual({ unchanged: 1, moved: 1, added: 1, removed: 1 });
  });
  it("says what changes in one sentence, and says nothing changes when nothing does", () => {
    expect(describePlanDiff({ unchanged: 3, moved: 6, added: 0, removed: 0 })).toBe(
      "This moves 6 planned articles; nothing already written changes.",
    );
    expect(describePlanDiff({ unchanged: 1, moved: 1, added: 2, removed: 3 })).toBe(
      "This moves 1 planned article, adds 2, unplans 3; nothing already written changes.",
    );
    expect(describePlanDiff({ unchanged: 4, moved: 0, added: 0, removed: 0 })).toBe(
      "Nothing on the calendar changes; nothing already written changes.",
    );
  });
  it("lowering the pace keeps the head of the queue", () => {
    const seven = buildPlan(many(60), { weeklyLimit: 7, from });
    const one = buildPlan(many(60), { weeklyLimit: 1, from });
    const d = diffPlan(seven, one);
    expect(d.added).toBe(0);
    expect(d.unchanged + d.moved).toBe(one.length);
    expect(d.removed).toBe(seven.length - one.length);
  });
});
