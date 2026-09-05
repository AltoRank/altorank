// ---------------------------------------------------------------------------
// API keys: generate, hash, classify
// ---------------------------------------------------------------------------
//
// A key is `altorank_live_` followed by 40 base62 characters, drawn with
// rejection sampling so every character is equally likely. Only the SHA-256
// of the full key is stored (api_keys.key_hash); the value itself is shown to
// the human once and then exists nowhere on our side.
//
// No Next imports, so the unit tests load this directly.

import { createHash, randomBytes } from "node:crypto";

export const API_KEY_PREFIX = "altorank_live_";
export const API_KEY_RANDOM_LENGTH = 40;

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** How many leading characters the list shows so a human can tell keys apart. */
export const DISPLAY_PREFIX_LENGTH = API_KEY_PREFIX.length + 6;

export type GeneratedApiKey = {
  /** The full key. Shown once, never stored. */
  key: string;
  /** sha256 hex of `key`; what the row stores and what auth looks up. */
  hash: string;
  /** `altorank_live_` plus a few characters, safe to store and display. */
  prefix: string;
};

function randomBase62(length: number): string {
  let out = "";
  while (out.length < length) {
    // 248 is the largest multiple of 62 below 256; bytes at or above it are
    // discarded so no character is more likely than another.
    for (const byte of randomBytes(length)) {
      if (byte < 248) out += BASE62[byte % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

export function generateApiKey(): GeneratedApiKey {
  const key = API_KEY_PREFIX + randomBase62(API_KEY_RANDOM_LENGTH);
  return { key, hash: hashApiKey(key), prefix: key.slice(0, DISPLAY_PREFIX_LENGTH) };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** Cheap shape check before touching the database. */
export function looksLikeApiKey(value: string | null | undefined): value is string {
  if (!value) return false;
  if (!value.startsWith(API_KEY_PREFIX)) return false;
  const rest = value.slice(API_KEY_PREFIX.length);
  return rest.length === API_KEY_RANDOM_LENGTH && /^[0-9A-Za-z]+$/.test(rest);
}

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

export function expiryFromDays(days: number | null, now: Date = new Date()): string | null {
  if (days === null) return null;
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Every scope a v1 endpoint checks.
 *
 *   read      GET anything in the account; keyword suggestions (research spend)
 *   generate  POST /articles/generate - drafts into the review queue
 *   write     mutations: reschedule/remove planned keywords, find-and-replace
 *             in a draft, retry a failed publish, pause/resume a site
 *
 * None of them approves or publishes a draft; there is no scope for that.
 */
export const ALL_SCOPES = ["read", "generate", "write"] as const;
export type ApiKeyScope = (typeof ALL_SCOPES)[number];

/** What a freshly created key may do unless the human ticks "write". */
export const DEFAULT_SCOPES: readonly ApiKeyScope[] = ["read", "generate"];

export const SCOPE_LABELS: Record<ApiKeyScope, string> = {
  read: "Read",
  generate: "Generate drafts",
  write: "Edit plan, drafts and site status",
};
