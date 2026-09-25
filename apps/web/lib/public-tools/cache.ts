// ---------------------------------------------------------------------------
// A small in-memory answer cache
// ---------------------------------------------------------------------------
//
// A tool result shared in a chat gets opened many times; the site it
// describes should be fetched once. Per instance and lost on a cold start,
// like the rate limiter: enough to absorb a burst, not a shared store.
// Checked before the rate limit, so a cached answer costs the caller nothing.

import type { Block } from "./blocks";

const MAX_ENTRIES = 300;

type Entry = { blocks: Block[]; expiresAt: number };
const store = new Map<string, Entry>();

/** Stable JSON: object keys sorted, so {a,b} and {b,a} are one entry. */
export function cacheKey(slug: string, input: unknown): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return `${slug}:${JSON.stringify(stable(input))}`;
}

export function getCached(key: string, now = Date.now()): Block[] | null {
  const hit = store.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= now) {
    store.delete(key);
    return null;
  }
  return hit.blocks;
}

export function setCached(key: string, blocks: Block[], ttlMs: number, now = Date.now()): void {
  if (ttlMs <= 0) return;
  store.delete(key);
  store.set(key, { blocks, expiresAt: now + ttlMs });
  // Map iterates in insertion order: the first key is the oldest write.
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** Tests only. */
export function clearCache(): void {
  store.clear();
}
