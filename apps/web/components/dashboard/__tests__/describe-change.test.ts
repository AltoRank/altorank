import { describe, it, expect } from "vitest";
import { describeChange } from "../gsc-blocks";

describe("describeChange", () => {
  it("states a percentage when one is given", () => {
    expect(describeChange({ current: 120, previous: 100, changePct: 20 }, 28, "clicks")).toBe("+20% vs previous 28d");
  });

  it("says no prior period when the previous window is not whole", () => {
    expect(describeChange({ current: 120, previous: null, changePct: null }, 28, "clicks")).toBe("no prior period synced");
  });

  it("gives the previous figure when its baseline is zero and both windows are whole", () => {
    expect(describeChange({ current: 5, previous: 0, changePct: null }, 28, "clicks")).toBe("0 clicks in the previous 28d");
  });

  it("gives no previous figure beside a current window missing its newest days", () => {
    // 1,000 clicks last month beside 600 so far this month would read as a 40% drop.
    const text = describeChange({ current: 600, previous: 1_000, changePct: null }, 28, "clicks", false);
    expect(text).not.toMatch(/1,000/);
    expect(text).toMatch(/not synced/);
  });
});
