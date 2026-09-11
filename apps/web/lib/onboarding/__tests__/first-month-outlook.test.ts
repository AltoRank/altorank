import { describe, expect, it } from "vitest";
import { estimateFirstMonthTraffic, worthShowing } from "@/lib/onboarding/first-month-outlook";

describe("estimateFirstMonthTraffic", () => {
  it("is a range, and the low end is always below the high", () => {
    const r = estimateFirstMonthTraffic([{ volume: 1000, difficulty: 20 }], 50);
    expect(r.low).toBeGreaterThan(0);
    expect(r.high).toBeGreaterThan(r.low);
    expect(r.counted).toBe(1);
  });

  // The planner refuses to write these, so selling their volume would price
  // articles the product declines to produce.
  it("earns nothing from keywords out of reach for this site", () => {
    const r = estimateFirstMonthTraffic([{ volume: 500000, difficulty: 99 }], 1);
    expect(r.high).toBe(0);
    expect(r.counted).toBe(0);
    expect(r.excluded).toBe(1);
  });

  it("leaves out keywords with no volume to estimate from", () => {
    const r = estimateFirstMonthTraffic(
      [{ volume: null, difficulty: 10 }, { volume: 0, difficulty: 10 }],
      50,
    );
    expect(r.counted).toBe(0);
    expect(r.excluded).toBe(2);
  });

  // A new site has no authority reading on day one. Dropping every keyword
  // then would show "no estimate" to exactly the people being asked to decide.
  it("still estimates when authority is unknown, at the conservative band", () => {
    const unknown = estimateFirstMonthTraffic([{ volume: 1000, difficulty: 30 }], null);
    const easy = estimateFirstMonthTraffic([{ volume: 1000, difficulty: 30 }], 90);
    expect(unknown.counted).toBe(1);
    expect(unknown.high).toBeLessThan(easy.high);
  });

  it("an easier keyword is worth more than a harder one at the same volume", () => {
    const easy = estimateFirstMonthTraffic([{ volume: 1000, difficulty: 5 }], 60);
    const hard = estimateFirstMonthTraffic([{ volume: 1000, difficulty: 70 }], 60);
    expect(easy.high).toBeGreaterThan(hard.high);
  });

  it("adds up across the month", () => {
    const one = estimateFirstMonthTraffic([{ volume: 1000, difficulty: 20 }], 50);
    const three = estimateFirstMonthTraffic(
      Array.from({ length: 3 }, () => ({ volume: 1000, difficulty: 20 })),
      50,
    );
    expect(three.high).toBe(one.high * 3);
  });

  it("is empty, not broken, with nothing planned", () => {
    expect(estimateFirstMonthTraffic([], 50)).toEqual({ low: 0, high: 0, counted: 0, excluded: 0 });
  });
});

describe("worthShowing", () => {
  it("says no to a range that reads as a reason not to buy", () => {
    expect(worthShowing({ low: 0, high: 3, counted: 2, excluded: 0 })).toBe(false);
    expect(worthShowing({ low: 0, high: 0, counted: 0, excluded: 4 })).toBe(false);
  });
  it("says yes once there is something to say", () => {
    expect(worthShowing({ low: 12, high: 40, counted: 3, excluded: 0 })).toBe(true);
  });
});
