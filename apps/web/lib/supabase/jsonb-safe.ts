// ---------------------------------------------------------------------------
// A value Postgres will store: no NUL, no lone surrogate
// ---------------------------------------------------------------------------
//
// Postgres refuses `\u0000` in text and in jsonb ("unsupported Unicode escape
// sequence"), and a lone UTF-16 surrogate in jsonb. Both arrive from text we
// did not write: a results page's description, a crawled page's figure, a
// model's answer. One such character anywhere in an article's research made
// its whole update fail - the outline that opens a first look's gate, and
// then the saved article (2 of 4 proof runs on one site, 2026-10-11).
//
// So what the writer saves is passed through this first. Pure: it returns a
// copy and leaves its input alone.

const NUL = /\u0000/g;
/** A high surrogate not followed by a low one, or a low one not preceded by a high one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** `s` with NUL removed and every lone surrogate replaced by U+FFFD. */
export function storableText(s: string): string {
  return s.replace(NUL, "").replace(LONE_SURROGATE, "\uFFFD");
}

/**
 * A deep copy of `value` that Postgres stores as text or jsonb: every string,
 * key included, through `storableText`. Dates and other objects with a
 * `toJSON` are serialised as JSON would serialise them.
 */
export function jsonbSafe<T>(value: T): T {
  return clean(value, 0) as T;
}

function clean(value: unknown, depth: number): unknown {
  if (typeof value === "string") return storableText(value);
  if (value === null || typeof value !== "object") return value;
  // Deeper than any row we write: left as it is rather than walked for ever.
  if (depth > 64) return value;
  if (Array.isArray(value)) return value.map((v) => clean(v, depth + 1));
  const withJson = value as { toJSON?: () => unknown };
  if (typeof withJson.toJSON === "function") return clean(withJson.toJSON(), depth + 1);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[storableText(k)] = clean(v, depth + 1);
  return out;
}
