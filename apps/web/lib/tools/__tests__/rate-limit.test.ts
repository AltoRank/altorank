import { describe, it, expect, vi, afterEach } from "vitest";
import { checkToolRateLimit } from "../rate-limit";

afterEach(() => vi.useRealTimers());

describe("checkToolRateLimit", () => {
  it("allows up to the limit, then refuses, per slug and ip", () => {
    const slug = `t-${Math.random()}`;
    expect(checkToolRateLimit(slug, "1.1.1.1", 3, 60_000)).toBe(true);
    expect(checkToolRateLimit(slug, "1.1.1.1", 3, 60_000)).toBe(true);
    expect(checkToolRateLimit(slug, "1.1.1.1", 3, 60_000)).toBe(true);
    expect(checkToolRateLimit(slug, "1.1.1.1", 3, 60_000)).toBe(false);
    // Another ip and another slug are separate buckets.
    expect(checkToolRateLimit(slug, "2.2.2.2", 3, 60_000)).toBe(true);
    expect(checkToolRateLimit(`${slug}-other`, "1.1.1.1", 3, 60_000)).toBe(true);
  });

  it("resets once the window has passed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T10:00:00Z"));
    const slug = `t-${Math.random()}`;
    expect(checkToolRateLimit(slug, "1.1.1.1", 1, 60_000)).toBe(true);
    expect(checkToolRateLimit(slug, "1.1.1.1", 1, 60_000)).toBe(false);
    vi.advanceTimersByTime(60_001);
    expect(checkToolRateLimit(slug, "1.1.1.1", 1, 60_000)).toBe(true);
  });
});
