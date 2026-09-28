import { describe, expect, it } from "vitest";
import { MAX_REPORT_DAYS, assertReportPeriod } from "../period";

describe("assertReportPeriod", () => {
  it("accepts a month, a single day and the longest allowed period", () => {
    expect(() => assertReportPeriod("2026-08-01", "2026-08-31")).not.toThrow();
    expect(() => assertReportPeriod("2026-08-31", "2026-08-31")).not.toThrow();
    // 2025-05-01 + 495 days = 2026-09-08: exactly MAX_REPORT_DAYS days, both ends counted.
    expect(MAX_REPORT_DAYS).toBe(496);
    expect(() => assertReportPeriod("2025-05-01", "2026-09-08")).not.toThrow();
  });

  it("refuses a period one day longer than that", () => {
    expect(() => assertReportPeriod("2025-05-01", "2026-09-09")).toThrow(/at most 496 days/);
  });

  it("refuses the year-9999 end that used to spin the day walk forever", () => {
    expect(() => assertReportPeriod("0001-01-01", "9999-12-31")).toThrow(/at most/);
  });

  it("refuses an end before the start", () => {
    expect(() => assertReportPeriod("2026-09-02", "2026-09-01")).toThrow(/after it ends/);
  });

  it.each([
    ["an empty string", ""],
    ["a date that is not in the calendar", "2026-02-30"],
    ["another format", "01/08/2026"],
    ["a path", "../../other/2026-08-01"],
    ["a timestamp", "2026-08-01T00:00:00Z"],
    ["a non-string from a crafted request", 20260801 as unknown as string],
  ])("refuses %s", (_label, value) => {
    expect(() => assertReportPeriod(value, "2026-08-31")).toThrow(/start date is not a YYYY-MM-DD date/);
    expect(() => assertReportPeriod("2026-08-01", value)).toThrow(/end date is not a YYYY-MM-DD date/);
  });
});
