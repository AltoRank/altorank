// ---------------------------------------------------------------------------
// Bearer-key authentication for the agent API
// ---------------------------------------------------------------------------
//
// `Authorization: Bearer altorank_live_…`. The key is hashed and looked up;
// the row says which account it belongs to, whether it has expired or been
// revoked, and what it may do. Every refusal is an envelope with guidance,
// because the reader is an agent that has to explain the failure to a person.
//
// The lookup runs on the service role: there is no user session to build an
// RLS client from, and the key itself is the credential. That puts the agency
// boundary on this module and on lib/agent/data.ts rather than on the
// database, so every read there filters by the agency the key resolved to.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/server";
import { apiKeyState, hashApiKey, looksLikeApiKey, type ApiKeyScope } from "./api-keys";
import { fail, GUIDANCE, type FailEnvelope } from "./envelope";
import { agentRateLimiter, type RateLimitDecision } from "./rate-limit";

export type AgentContext = {
  /** Service-role client. Every query MUST filter by `agencyId`. */
  supabase: SupabaseClient;
  key: { id: string; name: string; scopes: string[]; expires_at: string | null; last_used_at: string | null };
  agencyId: string;
  rate: RateLimitDecision;
};

export type AuthOutcome =
  | { ok: true; ctx: AgentContext }
  | { ok: false; envelope: FailEnvelope; rate?: RateLimitDecision };

export function bearerFrom(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (!auth || !auth.toLowerCase().startsWith("bearer ")) return null;
  return auth.slice(7).trim() || null;
}

/** Only touch the row once a minute: a chatty agent should not write per request. */
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

export async function authenticateAgentRequest(
  request: Request,
  requiredScope?: ApiKeyScope,
): Promise<AuthOutcome> {
  const raw = bearerFrom(request);
  if (!raw) return { ok: false, envelope: fail("unauthorized", "Missing API key.", GUIDANCE.missingKey) };
  if (!looksLikeApiKey(raw)) {
    return { ok: false, envelope: fail("unauthorized", "Malformed API key.", GUIDANCE.malformedKey) };
  }

  const supabase = createServiceClient();
  const { data: row } = await supabase
    .from("api_keys")
    .select("id, agency_id, name, scopes, expires_at, last_used_at, revoked_at")
    .eq("key_hash", hashApiKey(raw))
    .maybeSingle();

  if (!row) return { ok: false, envelope: fail("unauthorized", "Unknown API key.", GUIDANCE.unknownKey) };

  const state = apiKeyState(row);
  if (state === "revoked") {
    return { ok: false, envelope: fail("unauthorized", "This API key was revoked.", GUIDANCE.revokedKey) };
  }
  if (state === "expired") {
    return { ok: false, envelope: fail("unauthorized", "This API key has expired.", GUIDANCE.expiredKey) };
  }

  const rate = agentRateLimiter.check(row.id);
  if (!rate.allowed) {
    return {
      ok: false,
      rate,
      envelope: fail("rate_limited", "Too many requests for this API key.", GUIDANCE.rateLimited(rate.retryAfterSeconds)),
    };
  }

  const scopes: string[] = Array.isArray(row.scopes) ? row.scopes : [];
  if (requiredScope && !scopes.includes(requiredScope)) {
    return {
      ok: false,
      rate,
      envelope: fail("forbidden", `This key lacks the "${requiredScope}" scope.`, GUIDANCE.missingScope(requiredScope)),
    };
  }

  const lastUsed = row.last_used_at ? new Date(row.last_used_at).getTime() : 0;
  if (Date.now() - lastUsed > LAST_USED_WRITE_INTERVAL_MS) {
    // Best effort; a failed bookkeeping write must not fail the request.
    void supabase
      .from("api_keys")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", row.id)
      .then(() => undefined, () => undefined);
  }

  return {
    ok: true,
    ctx: {
      supabase,
      key: { id: row.id, name: row.name, scopes, expires_at: row.expires_at, last_used_at: row.last_used_at },
      agencyId: row.agency_id,
      rate,
    },
  };
}
