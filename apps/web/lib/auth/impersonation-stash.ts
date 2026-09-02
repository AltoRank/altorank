import { decrypt, encrypt } from "@/lib/crypto";

/**
 * What the operator's browser carries while it is signed in as somebody else.
 *
 * The cookie answers the two questions the swapped session cannot: who to
 * become again, and whether this browser is entitled to become them. It holds
 * no token. Coming back mints a fresh session for the operator's address at
 * that moment (app/actions/impersonation.ts), so there is no refresh token to
 * stash, to have rotated out from under us, or to leak.
 *
 * Encrypted with the same AES-256-GCM key as stored CMS credentials, which
 * doubles as an authentication tag: an edited or invented cookie fails to
 * decrypt and is treated as absent. Bound to the `session_id` of the session
 * that was minted for the target, so the stash is honoured only from inside
 * that exact session. A customer signed in normally cannot present it even if
 * they somehow had it, and once the operator signs out it is inert.
 */
export type ImpersonationStash = {
  v: 1;
  /** Who started it, and therefore who "stop" turns this browser back into. */
  operator: { id: string; email: string };
  /** Whose account is on screen. */
  target: { id: string; email: string };
  /** `session_id` claim of the session minted for the target. */
  sessionId: string;
  startedAt: string;
  /** admin_impersonations.id, so stopping can close the row. */
  logId: string | null;
};

export const IMPERSONATION_COOKIE = "altorank_operator";

/**
 * A week. Long on purpose: the cookie is a marker, not a credential, and if it
 * expired before the operator clicked Stop they would be left signed in as the
 * customer with no banner and no way back short of signing out.
 */
export const IMPERSONATION_MAX_AGE_S = 7 * 24 * 60 * 60;

export function encodeStash(stash: ImpersonationStash): string {
  return encrypt(JSON.stringify(stash));
}

/** Null for anything we did not write: tampered, a rotated key, the wrong shape. */
export function decodeStash(raw: string | undefined | null): ImpersonationStash | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decrypt(raw));
  } catch {
    return null;
  }
  return isStash(parsed) ? parsed : null;
}

function isPerson(p: unknown): p is { id: string; email: string } {
  if (typeof p !== "object" || p === null) return false;
  const r = p as Record<string, unknown>;
  return typeof r.id === "string" && r.id.length > 0 && typeof r.email === "string" && r.email.length > 0;
}

function isStash(x: unknown): x is ImpersonationStash {
  if (typeof x !== "object" || x === null) return false;
  const s = x as Record<string, unknown>;
  return (
    s.v === 1 &&
    isPerson(s.operator) &&
    isPerson(s.target) &&
    typeof s.sessionId === "string" &&
    s.sessionId.length > 0 &&
    typeof s.startedAt === "string" &&
    (s.logId === null || typeof s.logId === "string")
  );
}

/**
 * The `session_id` claim of an access token, read without verifying it.
 *
 * Only for a token that arrived from the auth server in the same call, i.e.
 * the one `verifyOtp` just returned. Anything read back from the browser goes
 * through `auth.getClaims()`, which verifies the signature first.
 */
export function sessionIdOf(accessToken: string): string | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    return typeof payload.session_id === "string" && payload.session_id ? payload.session_id : null;
  } catch {
    return null;
  }
}
