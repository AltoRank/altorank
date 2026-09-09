// ---------------------------------------------------------------------------
// Authorization codes and the token they turn into
// ---------------------------------------------------------------------------
//
// A code is minted when an owner or admin approves a connector on
// /oauth/authorize, lives ten minutes, and can be exchanged exactly once. The
// exchange checks the PKCE verifier, the client and the redirect_uri, then
// creates an API key: that key is the access token. From here on the
// connector is indistinguishable from a key made on /settings/api-keys, which
// is deliberate (see migration 080).

import type { SupabaseClient } from "@supabase/supabase-js";
import { ALL_SCOPES, DEFAULT_SCOPES, expiryFromDays, generateApiKey, type ApiKeyScope } from "@/lib/agent/api-keys";
import { opaqueToken, sha256Hex, verifyPkce } from "./pkce";

export const CODE_TTL_MS = 10 * 60 * 1000;

/**
 * How long a connector's token lives before the person has to approve it
 * again. Long enough that a weekly ChatGPT user is not re-consenting every
 * time; short enough that a connector nobody uses any more stops working on
 * its own. Revocation on /settings/api-keys is immediate regardless.
 */
export const TOKEN_TTL_DAYS = 90;

/** Parse a space-separated scope string against the scopes the API knows. */
export function parseScopes(raw: string | null | undefined): { scopes: ApiKeyScope[]; unknown: string[] } {
  const wanted = (raw ?? "").split(/[\s+]+/).filter(Boolean);
  const scopes = new Set<ApiKeyScope>(DEFAULT_SCOPES);
  const unknown: string[] = [];
  for (const s of wanted) {
    if ((ALL_SCOPES as readonly string[]).includes(s)) scopes.add(s as ApiKeyScope);
    else unknown.push(s);
  }
  return { scopes: ALL_SCOPES.filter((s) => scopes.has(s)), unknown };
}

export type IssueCodeInput = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: ApiKeyScope[];
  accountId: string;
  userId: string;
};

export async function issueCode(supabase: SupabaseClient, input: IssueCodeInput, now = new Date()): Promise<string> {
  const code = opaqueToken(32);
  const { error } = await supabase.from("oauth_codes").insert({
    code_hash: sha256Hex(code),
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code_challenge: input.codeChallenge,
    scopes: input.scopes,
    account_id: input.accountId,
    user_id: input.userId,
    expires_at: new Date(now.getTime() + CODE_TTL_MS).toISOString(),
  });
  if (error) throw new Error(`Could not issue authorization code: ${error.message}`);
  return code;
}

export type ExchangeInput = {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  /** Shown on the keys page; the registered client_name. */
  clientName: string;
};

export type ExchangeOutcome =
  | {
      ok: true;
      token: { access_token: string; token_type: "bearer"; expires_in: number; scope: string };
      key: { id: string; accountId: string; userId: string; prefix: string; scopes: ApiKeyScope[]; expiresAt: string };
    }
  | { ok: false; error: "invalid_grant" | "invalid_request"; description: string };

export async function exchangeCode(supabase: SupabaseClient, input: ExchangeInput, now = new Date()): Promise<ExchangeOutcome> {
  if (!input.code || input.code.length > 200) return { ok: false, error: "invalid_request", description: "code is required." };

  const { data: row } = await supabase
    .from("oauth_codes")
    .select("code_hash, client_id, redirect_uri, code_challenge, scopes, account_id, user_id, expires_at, used_at")
    .eq("code_hash", sha256Hex(input.code))
    .maybeSingle();

  if (!row) return { ok: false, error: "invalid_grant", description: "Unknown authorization code." };
  if (row.used_at) return { ok: false, error: "invalid_grant", description: "This code was already exchanged." };
  if (new Date(row.expires_at).getTime() <= now.getTime()) {
    return { ok: false, error: "invalid_grant", description: "This code has expired; start the authorization again." };
  }
  if (row.client_id !== input.clientId) return { ok: false, error: "invalid_grant", description: "Code was issued to a different client." };
  if (row.redirect_uri !== input.redirectUri) return { ok: false, error: "invalid_grant", description: "redirect_uri does not match the authorization request." };
  if (!verifyPkce(input.codeVerifier, row.code_challenge)) return { ok: false, error: "invalid_grant", description: "PKCE verification failed." };

  // Burn the code first. If two exchanges race, the second update matches no
  // row and the loser gets invalid_grant rather than a second token.
  const { data: burned } = await supabase
    .from("oauth_codes")
    .update({ used_at: now.toISOString() })
    .eq("code_hash", row.code_hash)
    .is("used_at", null)
    .select("code_hash");
  if (!burned || burned.length === 0) return { ok: false, error: "invalid_grant", description: "This code was already exchanged." };

  const scopes = (row.scopes as ApiKeyScope[]) ?? [...DEFAULT_SCOPES];
  const generated = generateApiKey();
  const expiresAt = expiryFromDays(TOKEN_TTL_DAYS, now)!;
  const { data: key, error } = await supabase
    .from("api_keys")
    .insert({
      account_id: row.account_id,
      name: `${input.clientName} (connector)`,
      key_hash: generated.hash,
      prefix: generated.prefix,
      scopes,
      expires_at: expiresAt,
      created_by: row.user_id,
      oauth_client_id: row.client_id,
    })
    .select("id")
    .single();
  if (error || !key) return { ok: false, error: "invalid_request", description: `Could not create the token: ${error?.message ?? "unknown"}` };

  return {
    ok: true,
    token: {
      access_token: generated.key,
      token_type: "bearer",
      expires_in: Math.floor((new Date(expiresAt).getTime() - now.getTime()) / 1000),
      scope: scopes.join(" "),
    },
    key: { id: key.id as string, accountId: row.account_id, userId: row.user_id, prefix: generated.prefix, scopes, expiresAt },
  };
}
