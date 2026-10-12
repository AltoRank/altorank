import { encrypt, decrypt } from "@/lib/crypto";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
export const GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

export type GoogleIntegrationId = "gsc" | "ga4";

/**
 * What each connect asks Google for: only what it reads.
 *
 * One consent used to ask for Search Console AND Analytics whichever button
 * was pressed, so connecting Search Console during setup also asked for the
 * sensitive Analytics scope, which nothing in setup reads. Each entry point
 * now asks for its own scope, and `include_granted_scopes` (getAuthUrl) folds
 * whatever the person granted before into the new token, so connecting GA4
 * after Search Console yields one token good for both.
 */
export const SCOPES_BY_INTEGRATION: Record<GoogleIntegrationId, readonly string[]> = {
  gsc: [GSC_SCOPE],
  ga4: [GA4_SCOPE],
};

/**
 * Which integrations a token can serve, from the `scope` Google returned
 * with it. A token stored before the scopes were split carries no `scope`;
 * every one of those came from the combined consent, so it is read as both,
 * which is what the product assumed when it stored it.
 */
export function grantedIntegrations(scope: string | null | undefined): GoogleIntegrationId[] {
  if (scope === undefined || scope === null) return ["gsc", "ga4"];
  const granted = new Set(scope.split(/\s+/).filter(Boolean));
  return (Object.keys(SCOPES_BY_INTEGRATION) as GoogleIntegrationId[]).filter((id) =>
    SCOPES_BY_INTEGRATION[id].every((s) => granted.has(s)),
  );
}

/** Whether a stored (encrypted) token can serve this integration. */
export function tokenGrants(encrypted: string, integrationId: GoogleIntegrationId): boolean {
  return grantedIntegrations(decryptTokens(encrypted).scope).includes(integrationId);
}

function getCredentials() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Google OAuth credentials not configured");
  }

  return { clientId, clientSecret, redirectUri };
}

/**
 * Build the Google OAuth authorization URL for one integration's scopes.
 */
export function getAuthUrl(state: string, integrationId: GoogleIntegrationId): string {
  const { clientId, redirectUri } = getCredentials();

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES_BY_INTEGRATION[integrationId].join(" "),
    // Incremental authorization: the token also covers what this Google user
    // already granted this app, so a GA4 connect does not drop Search Console.
    include_granted_scopes: "true",
    access_type: "offline",
    prompt: "consent",
    state,
  });

  return `${GOOGLE_AUTH_URL}?${params}`;
}

export interface GoogleTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  /**
   * The scopes Google granted, space-separated, as its token response gives
   * them. Absent on tokens stored before the scopes were split; see
   * grantedIntegrations.
   */
  scope?: string;
}

/**
 * Exchange an authorization code for access + refresh tokens.
 */
export async function exchangeCode(code: string): Promise<GoogleTokens> {
  const { clientId, clientSecret, redirectUri } = getCredentials();

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google token exchange failed: ${err}`);
  }

  const data = await res.json();

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    ...(typeof data.scope === "string" ? { scope: data.scope } : {}),
  };
}

/**
 * Google refused the refresh token itself, not a single request: the person
 * revoked access, the account's password changed, the token aged out, or the
 * app's OAuth client changed. No retry will succeed; only a new consent will.
 * Callers that hold a connection row mark it needs_reconnect on this error
 * (lib/google/sync.ts) so the product stops asking and the person is told.
 */
export class GoogleReconnectError extends Error {
  readonly needsReconnect = true;
  constructor(message: string) {
    super(message);
    this.name = "GoogleReconnectError";
  }
}

export function isGoogleReconnectError(err: unknown): err is GoogleReconnectError {
  return err instanceof GoogleReconnectError || (typeof err === "object" && err !== null && (err as { needsReconnect?: unknown }).needsReconnect === true);
}

/**
 * Whether a failed refresh means the token is dead rather than the call
 * having failed. Google returns 400 `invalid_grant` for a revoked or expired
 * refresh token and 401 `invalid_client` for a client it no longer knows;
 * a 5xx or a network error is neither, and those are worth trying again
 * tomorrow.
 */
export function refreshFailureNeedsReconnect(status: number, body: string): boolean {
  if (status === 401) return true;
  if (status !== 400) return false;
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return parsed.error === "invalid_grant";
  } catch {
    return /invalid_grant/.test(body);
  }
}

/**
 * Refresh an expired access token.
 */
export async function refreshTokens(refreshToken: string): Promise<GoogleTokens> {
  const { clientId, clientSecret } = getCredentials();

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    if (refreshFailureNeedsReconnect(res.status, err)) {
      throw new GoogleReconnectError(
        `Google no longer accepts this connection's refresh token (${res.status}: ${err.trim().slice(0, 200)}). Reconnect Google to resume syncing.`,
      );
    }
    throw new Error(`Google token refresh failed: ${err}`);
  }

  const data = await res.json();

  return {
    access_token: data.access_token,
    refresh_token: refreshToken, // Keep original refresh token
    expires_at: Date.now() + data.expires_in * 1000,
    ...(typeof data.scope === "string" ? { scope: data.scope } : {}),
  };
}

/**
 * Encrypt tokens for DB storage.
 */
export function encryptTokens(tokens: GoogleTokens): string {
  return encrypt(JSON.stringify(tokens));
}

/**
 * Decrypt tokens from DB storage.
 */
export function decryptTokens(encrypted: string): GoogleTokens {
  return JSON.parse(decrypt(encrypted));
}

/**
 * Get a valid access token, refreshing if needed.
 */
export async function getValidAccessToken(
  encryptedTokens: string,
  onRefresh: (newEncrypted: string) => Promise<void>,
): Promise<string> {
  let tokens = decryptTokens(encryptedTokens);

  // Refresh if expired (with 5 min buffer)
  if (tokens.expires_at < Date.now() + 5 * 60 * 1000) {
    // A refresh answer normally restates the scopes; when it does not, the
    // grant is unchanged, so the stored one stands.
    const refreshed = await refreshTokens(tokens.refresh_token);
    const scope = refreshed.scope ?? tokens.scope;
    tokens = scope === undefined ? refreshed : { ...refreshed, scope };
    await onRefresh(encryptTokens(tokens));
  }

  return tokens.access_token;
}
