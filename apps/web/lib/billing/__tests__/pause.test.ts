import { describe, it, expect } from "vitest";
import { pausedUntil, pauseIsOver, resumesAtUnix, isPauseMonths, PAUSE_MONTHS } from "../pause";

describe("pause dates", () => {
  it("offers exactly one, two and three months", () => {
    expect([...PAUSE_MONTHS]).toEqual([1, 2, 3]);
    expect(isPauseMonths(2)).toBe(true);
    expect(isPauseMonths(4)).toBe(false);
    expect(isPauseMonths("1")).toBe(false);
  });
  it("adds whole months on the same day", () => {
    expect(pausedUntil(new Date("2026-09-04T10:00:00Z"), 1)).toBe("2026-10-04");
    expect(pausedUntil(new Date("2026-09-04T10:00:00Z"), 3)).toBe("2026-12-04");
  });
  it("clamps to the last day of a shorter month rather than spilling over", () => {
    expect(pausedUntil(new Date("2026-01-31T00:00:00Z"), 1)).toBe("2026-02-28");
    expect(pausedUntil(new Date("2028-01-31T00:00:00Z"), 1)).toBe("2028-02-29");
    expect(pausedUntil(new Date("2026-08-31T00:00:00Z"), 1)).toBe("2026-09-30");
  });
  it("crosses a year boundary", () => {
    expect(pausedUntil(new Date("2026-11-15T23:59:00Z"), 2)).toBe("2027-01-15");
  });
  it("uses UTC so a late-evening pause does not move a day", () => {
    expect(pausedUntil(new Date("2026-09-04T23:30:00Z"), 1)).toBe("2026-10-04");
  });
  it("knows when a pause is over, on the day itself", () => {
    expect(pauseIsOver("2026-10-04", new Date("2026-10-03T23:00:00Z"))).toBe(false);
    expect(pauseIsOver("2026-10-04", new Date("2026-10-04T00:00:00Z"))).toBe(true);
  });
  it("hands Stripe the start of that UTC day", () => {
    expect(resumesAtUnix("2026-10-04")).toBe(Date.UTC(2026, 9, 4) / 1000);
  });
});
