import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptTokens } from "@/lib/google/oauth";

// ---------------------------------------------------------------------------
// Disconnecting Google from an account
// ---------------------------------------------------------------------------
//
// One Google consent is stored twice over: as the account's consent in
// `account_integrations` (what /connect/google lists properties with), and
// copied onto the `gsc` / `ga4` row of every site on the account that it can
// read (the OAuth callback's linkAccountWorkspaces). So disconnecting one
// tile left the token in every other row and in the account's consent, and
// nothing ever asked Google to forget the grant. This removes every copy and
// then revokes each distinct refresh token at Google.
//
// The synced numbers stay: they are the site's history, not the credential.
// The revoke is best effort and comes after the deletes: a token that is no
// longer stored can no longer be used here, whatever Google answers, and a
// failed delete must not leave rows holding a token Google has just killed.

export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/** Why a disconnect was refused, in the words the button shows. */
export const GOOGLE_DISCONNECT_REFUSED =
  "Disconnecting Google removes it from every site on the account, so it needs access to every site. Ask the account owner.";

export const GOOGLE_INTEGRATION_IDS = ["gsc", "ga4"] as const;

/**
 * Ask Google to revoke a token. True when Google no longer honours it,
 * including a token it already considered dead (400 `invalid_token`).
 */
export async function revokeGoogleToken(token: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
    if (res.ok) return true;
    const body = await res.text().catch(() => "");
    return res.status === 400 && /invalid_token/.test(body);
  } catch {
    return false;
  }
}

function refreshTokenOf(stored: unknown): string | null {
  const encrypted = (stored as { encrypted?: unknown } | null)?.encrypted;
  if (typeof encrypted !== "string" || !encrypted) return null;
  try {
    return decryptTokens(encrypted).refresh_token || null;
  } catch {
    // Written under another key, or corrupt: unusable here, so nothing to revoke.
    return null;
  }
}

export interface GoogleDisconnectResult {
  /** Site connection rows deleted (Search Console and Analytics). */
  removedSiteConnections: number;
  /** Whether the account-level consent existed and was deleted. */
  removedAccountConsent: boolean;
  /** Distinct refresh tokens Google confirmed revoked. */
  revoked: number;
  /** Distinct refresh tokens Google could not be reached about, or refused. */
  revokeFailed: number;
}

/**
 * Delete every stored Google credential on an account and revoke it at
 * Google. Takes the service client: members may only read
 * `account_integrations` (migration 033), so the caller authorises first.
 */
export async function disconnectGoogleForAccount(
  admin: SupabaseClient,
  accountId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleDisconnectResult> {
  const { data: sites, error: sitesError } = await admin.from("workspaces").select("id").eq("account_id", accountId);
  if (sitesError) throw new Error(`Could not read the account's sites: ${sitesError.message}`);
  const siteIds = (sites ?? []).map((s) => s.id as string);

  const { data: rows, error: rowsError } = siteIds.length
    ? await admin
        .from("workspace_integrations")
        .select("id, tokens")
        .in("workspace_id", siteIds)
        .in("integration_id", [...GOOGLE_INTEGRATION_IDS])
    : { data: [], error: null };
  if (rowsError) throw new Error(`Could not read the Google connections: ${rowsError.message}`);

  const { data: consent, error: consentError } = await admin
    .from("account_integrations")
    .select("id, tokens")
    .eq("account_id", accountId)
    .eq("provider", "google")
    .maybeSingle();
  if (consentError) throw new Error(`Could not read the account's Google consent: ${consentError.message}`);

  const tokens = new Set<string>();
  for (const stored of [...(rows ?? []).map((r) => r.tokens), consent?.tokens]) {
    const token = refreshTokenOf(stored);
    if (token) tokens.add(token);
  }

  const rowIds = (rows ?? []).map((r) => r.id as string);
  if (rowIds.length) {
    const { error } = await admin.from("workspace_integrations").delete().in("id", rowIds);
    if (error) throw new Error(`Could not remove the Google connections: ${error.message}`);
  }
  if (consent) {
    const { error } = await admin
      .from("account_integrations")
      .delete()
      .eq("account_id", accountId)
      .eq("provider", "google");
    if (error) throw new Error(`Could not remove the account's Google consent: ${error.message}`);
  }

  let revoked = 0;
  let revokeFailed = 0;
  for (const token of tokens) {
    if (await revokeGoogleToken(token, fetchImpl)) revoked++;
    else revokeFailed++;
  }

  return { removedSiteConnections: rowIds.length, removedAccountConsent: Boolean(consent), revoked, revokeFailed };
}
