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
export function checkToolRateLimit(
  slug: string,
  ip: string,
  limit: number,
  windowMs: number,
): boolean {
  const map = getMap(slug);
  const now = Date.now();
  const entry = map.get(ip);

  if (!entry || now > entry.resetAt) {
    map.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (entry.count >= limit) return false;

  entry.count++;
  return true;
}
