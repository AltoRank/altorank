// ---------------------------------------------------------------------------
// API keys: where a key stands, and the expiry choices
// ---------------------------------------------------------------------------
//
// The half of lib/agent/api-keys.ts the browser reads: the API keys panel is
// a client component and shows each key's state and the expiry picker.
// api-keys.ts generates and hashes keys with node:crypto, which Next can only
// put in a browser bundle by shipping a crypto polyfill, and it did - until
// 2026-09-25, when a guard (lib/__tests__/client-bundle-guard.test.ts) found
// the chain. No imports here, on purpose.

export type ApiKeyState = "active" | "expired" | "revoked";

/**
 * Where a key stands right now. Revocation wins over expiry: a revoked key
 * that has also expired was revoked, and that is the fact the human acted on.
 */
export function apiKeyState(
  row: { revoked_at: string | null; expires_at: string | null },
  now: Date = new Date(),
): ApiKeyState {
  if (row.revoked_at) return "revoked";
  if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) return "expired";
  return "active";
}

/** Expiration choices offered at creation, in days. Null is "never". */
export const EXPIRY_OPTIONS: readonly { label: string; days: number | null }[] = [
  { label: "Never", days: null },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "180 days", days: 180 },
  { label: "365 days", days: 365 },
];
