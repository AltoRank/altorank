// ---------------------------------------------------------------------------
// Reusable in-memory rate limiter for free tools — resets on deploy
// ---------------------------------------------------------------------------

type RateEntry = { count: number; resetAt: number };

const rateMaps = new Map<string, Map<string, RateEntry>>();

/** Get or create a rate map for a given tool slug. */
function getMap(slug: string): Map<string, RateEntry> {
  let map = rateMaps.get(slug);
  if (!map) {
    map = new Map();
    rateMaps.set(slug, map);
  }
  return map;
}

/**
 * Check rate limit for a tool + IP pair.
 * Returns `true` if the request is allowed, `false` if rate-limited.
 */
export interface RateLimitState {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Epoch milliseconds when the window resets. */
  resetAt: number;
}

/** Take one unit from the window and say where it stands, for response headers. */
export function takeToolRateLimit(slug: string, ip: string, limit: number, windowMs: number): RateLimitState {
  const map = getMap(slug);
  const now = Date.now();
  const entry = map.get(ip);

  if (!entry || now > entry.resetAt) {
    map.set(ip, { count: 1, resetAt: now + windowMs });
    return { allowed: true, limit, remaining: Math.max(0, limit - 1), resetAt: now + windowMs };
  }
  if (entry.count >= limit) return { allowed: false, limit, remaining: 0, resetAt: entry.resetAt };
  entry.count++;
  return { allowed: true, limit, remaining: Math.max(0, limit - entry.count), resetAt: entry.resetAt };
}

export function rateLimitHeaders(s: RateLimitState): Record<string, string> {
  const h: Record<string, string> = {
    "X-RateLimit-Limit": String(s.limit),
    "X-RateLimit-Remaining": String(s.remaining),
    "X-RateLimit-Reset": String(Math.ceil(s.resetAt / 1000)),
  };
  if (!s.allowed) h["Retry-After"] = String(Math.max(1, Math.ceil((s.resetAt - Date.now()) / 1000)));
  return h;
}

export function checkToolRateLimit(slug: string, ip: string, limit: number, windowMs: number): boolean {
  return takeToolRateLimit(slug, ip, limit, windowMs).allowed;
}
