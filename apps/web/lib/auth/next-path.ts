/**
 * Where to send someone after they sign in, when a page asked for them back.
 *
 * Only a same-site path is honoured: `/oauth/authorize?...` when a connector
 * sent the person to sign in first. Anything with a scheme, a
 * protocol-relative `//`, or a backslash is dropped, so `?next=` can never
 * become an open redirect. Null means "the default", which the caller picks.
 */
export function safeNextPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  if (raw.length > 2048) return null;
  return raw;
}
