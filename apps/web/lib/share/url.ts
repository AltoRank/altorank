// ---------------------------------------------------------------------------
// The share link's URL, and nothing else
// ---------------------------------------------------------------------------
//
// Split out of lib/share/token.ts because that module imports node:crypto to
// mint tokens, and the "Copy link" button (components/dashboard/share-results.tsx,
// a client component) only needs to build a URL. Importing the token module
// from the client pulled node:crypto into the browser graph (PM-E-N7,
// 2026-09-06). This file imports nothing.

/** `origin` may be empty, which gives the path alone. */
export function shareUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/share/${token}`;
}
