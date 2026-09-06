import { describe, expect, it } from "vitest";
import { rateLimitHeaders, RateLimiter } from "../rate-limit";

describe("RateLimiter", () => {
  it("allows up to the limit in one window, then refuses", () => {
    const rl = new RateLimiter(3, 60_000);
    const t = 1_000_000;
    expect(rl.check("k", t).remaining).toBe(2);
    expect(rl.check("k", t + 1).remaining).toBe(1);
    expect(rl.check("k", t + 2).remaining).toBe(0);
    const refused = rl.check("k", t + 3);
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.retryAfterSeconds).toBe(60);
  });

  it("resets when the window ends", () => {
    const rl = new RateLimiter(1, 1_000);
    expect(rl.check("k", 0).allowed).toBe(true);
    expect(rl.check("k", 999).allowed).toBe(false);
    expect(rl.check("k", 1_000).allowed).toBe(true);
  });

  it("keeps keys apart", () => {
    const rl = new RateLimiter(1, 60_000);
    expect(rl.check("a", 0).allowed).toBe(true);
    expect(rl.check("b", 0).allowed).toBe(true);
    expect(rl.check("a", 1).allowed).toBe(false);
  });

  it("reports the window end as unix seconds", () => {
    const rl = new RateLimiter(5, 60_000);
    expect(rl.check("k", 120_000).resetAt).toBe(180);
  });

  it("defaults to 120 a minute", () => {
    const rl = new RateLimiter();
    expect(rl.check("k", 0).limit).toBe(120);
  });
});

describe("rateLimitHeaders", () => {
  it("sets the X-RateLimit trio, plus Retry-After only when refused", () => {
    const rl = new RateLimiter(1, 60_000);
    const okHeaders = rateLimitHeaders(rl.check("k", 0));
    expect(okHeaders).toEqual({
      "X-RateLimit-Limit": "1",
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": "60",
    });
    const refused = rateLimitHeaders(rl.check("k", 30_000));
    expect(refused["Retry-After"]).toBe("30");
  });
});
