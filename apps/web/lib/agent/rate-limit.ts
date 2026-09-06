// ---------------------------------------------------------------------------
// Per-key rate limit, fixed window, in memory
// ---------------------------------------------------------------------------
//
// 120 requests a minute per API key. The counter lives in the module, which
// means it is per running instance: on a serverless host each warm function
// keeps its own count, so a key spread across several instances can exceed
// the nominal limit by roughly the instance count, and a cold start resets it.
// That is a known limitation of this first cut. The limit exists to stop a
// looping agent from hammering one instance, not to meter usage; moving it to
// a shared store is a one-file change when it needs to be exact.
//
// No Next imports; the clock is injectable so the tests are deterministic.

export const DEFAULT_LIMIT = 120;
export const DEFAULT_WINDOW_MS = 60_000;

export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix seconds when the current window ends. */
  resetAt: number;
  /** Seconds until the window ends; only meaningful when not allowed. */
  retryAfterSeconds: number;
};

type Bucket = { count: number; windowStart: number };

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit = DEFAULT_LIMIT,
    private readonly windowMs = DEFAULT_WINDOW_MS,
  ) {}

  check(key: string, now: number = Date.now()): RateLimitDecision {
    let bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= this.windowMs) {
      bucket = { count: 0, windowStart: now };
      this.buckets.set(key, bucket);
      // Keep the map from growing without bound on a long-lived instance.
      if (this.buckets.size > 10_000) this.sweep(now);
    }

    const windowEnd = bucket.windowStart + this.windowMs;
    const resetAt = Math.ceil(windowEnd / 1000);
    const retryAfterSeconds = Math.max(1, Math.ceil((windowEnd - now) / 1000));

    if (bucket.count >= this.limit) {
      return { allowed: false, limit: this.limit, remaining: 0, resetAt, retryAfterSeconds };
    }

    bucket.count += 1;
    return {
      allowed: true,
      limit: this.limit,
      remaining: this.limit - bucket.count,
      resetAt,
      retryAfterSeconds: 0,
    };
  }

  private sweep(now: number): void {
    for (const [k, b] of this.buckets) {
      if (now - b.windowStart >= this.windowMs) this.buckets.delete(k);
    }
  }
}

export function rateLimitHeaders(d: RateLimitDecision): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(d.limit),
    "X-RateLimit-Remaining": String(d.remaining),
    "X-RateLimit-Reset": String(d.resetAt),
  };
  if (!d.allowed) headers["Retry-After"] = String(d.retryAfterSeconds);
  return headers;
}

/** The one limiter the HTTP routes share. */
export const agentRateLimiter = new RateLimiter();
