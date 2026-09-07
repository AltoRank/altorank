// ---------------------------------------------------------------------------
// Which address is the caller, for a rate limit that cannot be wished away
// ---------------------------------------------------------------------------
//
// `x-forwarded-for` is a list the proxies append to, so the FIRST entry is
// whatever the client sent - a header anybody can write. Reading it as the
// caller's address turns every per-IP limit into a formality: send
// `x-forwarded-for: <random>` on each request and the counter never fills.
//
// The trustworthy value is the one our own edge wrote. On Vercel that is
// `x-real-ip` (and `x-vercel-forwarded-for`, which the platform sets and a
// client cannot forge); behind any other single proxy it is the LAST entry of
// the forwarded chain, not the first. When there is no proxy at all there is
// nothing to read, and everyone shares the "unknown" bucket - which throttles
// harder than it should rather than not at all.

export function clientIp(headers: Headers): string {
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;

  const vercel = headers.get("x-vercel-forwarded-for")?.trim();
  if (vercel) return lastHop(vercel);

  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return lastHop(forwarded);

  return "unknown";
}

function lastHop(chain: string): string {
  const hops = chain
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return hops[hops.length - 1] ?? "unknown";
}
