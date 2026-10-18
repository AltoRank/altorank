import { describe, expect, it } from "vitest";
import { checkoutDestination, firstArticleReturn } from "../checkout-return";

describe("firstArticleReturn", () => {
  it("opens the first article after a trial started from the gate", () => {
    expect(firstArticleReturn("8f14e45f-ceea-467f-a0e6-1b2c3d4e5f60")).toBe("/content/8f14e45f-ceea-467f-a0e6-1b2c3d4e5f60");
  });

  it("falls back to the dashboard with no article", () => {
    expect(firstArticleReturn(null)).toBe("/dashboard");
    expect(firstArticleReturn(undefined)).toBe("/dashboard");
    expect(firstArticleReturn("")).toBe("/dashboard");
  });

  it("never builds a path out of anything but an id", () => {
    expect(firstArticleReturn("../settings")).toBe("/dashboard");
    expect(firstArticleReturn("a/b")).toBe("/dashboard");
  });

  it("lands a phone on the dashboard, where the editor does not fit", () => {
    expect(firstArticleReturn("8f14e45f-ceea-467f-a0e6-1b2c3d4e5f60", false)).toBe("/dashboard");
  });

  it("survives the post-checkout destination check unchanged", () => {
    const path = firstArticleReturn("8f14e45f-ceea-467f-a0e6-1b2c3d4e5f60");
    expect(checkoutDestination(path)).toBe(path);
  });
});
