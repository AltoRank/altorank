import { describe, it, expect } from "vitest";
import { nextOpenDates, PLAN_HORIZON_DAYS } from "../plan";
import { monthlyFromPace, FREE_TIER_PACE } from "@/lib/content/pace";

// The arithmetic PlanningSkeleton uses to decide which days get a placeholder.
// It must agree with the plan the server then writes, or the skeleton promises
// a shape the month does not take.
const want = (pace: number) =>
  Math.min(monthlyFromPace(pace), Math.ceil((pace * PLAN_HORIZON_DAYS) / 7));

describe("planning skeleton dates", () => {
  const from = new Date("2026-09-07T00:00:00Z");

  it("draws one placeholder per article the pace yields, not one per day", () => {
    expect(nextOpenDates([], 1, want(1), from)).toHaveLength(4);
    expect(nextOpenDates([], 3, want(3), from)).toHaveLength(13);
    expect(nextOpenDates([], FREE_TIER_PACE, want(FREE_TIER_PACE), from)).toHaveLength(30);
  });

  it("never marks more DAYS than the horizon, though a fast pace repeats a day", () => {
    // Above 7 a week the grid puts more than one entry on a day, so the date
    // list is longer than the horizon while the days it touches are not. The
    // skeleton renders unique days and counts entries, which is why it keeps
    // both numbers.
    for (const pace of [1, 2, 3, 5, 7, 14, 21]) {
      const dates = nextOpenDates([], pace, want(pace), from);
      expect(new Set(dates).size).toBeLessThanOrEqual(PLAN_HORIZON_DAYS);
      if (pace > 7) expect(dates.length).toBeGreaterThan(new Set(dates).size);
    }
  });

  it("skips days that already carry an entry", () => {
    const plain = nextOpenDates([], 7, want(7), from);
    const withOne = nextOpenDates([plain[0]], 7, want(7), from);
    expect(withOne).not.toContain(plain[0]);
  });
});
