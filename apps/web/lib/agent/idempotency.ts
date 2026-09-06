// ---------------------------------------------------------------------------
// Idempotency keys for the one agent call that spends money
// ---------------------------------------------------------------------------
//
// `generate` answers 202 and writes the draft afterwards, so a timed-out
// request looks the same as one that never arrived. Without a key the honest
// retry is a second draft and a second quota unit. With one, the first call
// claims (agency, key) before it writes anything, binds it to the row it
// created, and every repeat for 24 hours is answered with that row.
//
// The claim is an insert on a primary key, so two concurrent firsts cannot
// both win: the loser reads the winner's row back. Expired rows are reclaimed
// by the next use of the same key rather than by a sweeper.

import type { SupabaseClient } from "@supabase/supabase-js";

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_KEY_MAX = 200;
const TABLE = "agent_idempotency_keys";

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * The key the caller sent, from the header or the body field. Absent is
 * fine - the call is then not idempotent, which is the pre-key behaviour -
 * but a present key that cannot be stored is a request error, not a silent
 * downgrade to "not idempotent".
 */
export function idempotencyKeyFrom(
  request: Request,
  body: unknown,
): { ok: true; key: string | null } | { ok: false; message: string } {
  const fromBody = body && typeof body === "object" ? (body as { idempotency_key?: unknown }).idempotency_key : undefined;
  const raw = request.headers.get(IDEMPOTENCY_HEADER) ?? fromBody;
  if (raw === undefined || raw === null) return { ok: true, key: null };
  if (typeof raw !== "string") return { ok: false, message: "idempotency_key must be a string." };
  const key = raw.trim();
  if (!key) return { ok: true, key: null };
  if (key.length > IDEMPOTENCY_KEY_MAX) return { ok: false, message: `Idempotency-Key is longer than ${IDEMPOTENCY_KEY_MAX} characters.` };
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(key)) return { ok: false, message: "Idempotency-Key contains control characters." };
  return { ok: true, key };
}

type KeyRow = { agency_id: string; key: string; article_id: string | null; created_at: string };

export type IdempotencyClaim =
  | { state: "fresh" }
  | { state: "replay"; article_id: string | null; created_at: string };

export function isExpired(createdAt: string, now: number = Date.now()): boolean {
  const t = Date.parse(createdAt);
  return !Number.isFinite(t) || now - t > IDEMPOTENCY_TTL_MS;
}

async function readKey(supabase: SupabaseClient, agencyId: string, key: string): Promise<KeyRow | null> {
  const { data } = await supabase.from(TABLE).select("agency_id, key, article_id, created_at").eq("agency_id", agencyId).eq("key", key).maybeSingle();
  return (data as KeyRow | null) ?? null;
}

/**
 * Claim the key for this agency. `fresh` means this call owns it and must
 * bind or release it; `replay` means an earlier call within the TTL did.
 */
export async function claimIdempotencyKey(
  supabase: SupabaseClient,
  agencyId: string,
  key: string,
  now: number = Date.now(),
): Promise<IdempotencyClaim> {
  const existing = await readKey(supabase, agencyId, key);
  if (existing) {
    if (!isExpired(existing.created_at, now)) return { state: "replay", article_id: existing.article_id, created_at: existing.created_at };
    await releaseIdempotencyKey(supabase, agencyId, key);
  }
  const { error } = await supabase.from(TABLE).insert({ agency_id: agencyId, key, article_id: null, created_at: new Date(now).toISOString() });
  if (!error) return { state: "fresh" };
  if (error.code !== UNIQUE_VIOLATION) throw new Error(error.message);
  // Lost the race to a concurrent first call: answer with what it made.
  const winner = await readKey(supabase, agencyId, key);
  if (!winner) return { state: "fresh" };
  return { state: "replay", article_id: winner.article_id, created_at: winner.created_at };
}

export async function bindIdempotencyKey(supabase: SupabaseClient, agencyId: string, key: string, articleId: string): Promise<void> {
  const { error } = await supabase.from(TABLE).update({ article_id: articleId }).eq("agency_id", agencyId).eq("key", key);
  if (error) throw new Error(error.message);
}

/** Give the key back: the call it was claimed for wrote nothing. */
export async function releaseIdempotencyKey(supabase: SupabaseClient, agencyId: string, key: string): Promise<void> {
  await supabase.from(TABLE).delete().eq("agency_id", agencyId).eq("key", key);
}
