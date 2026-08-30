import { encrypt, decrypt } from "@/lib/crypto";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const SCOPES = [
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/webmasters.readonly",
].join(" ");

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
 * Build the Google OAuth authorization URL.
 */
export function getAuthUrl(state: string): string {
  const { clientId, redirectUri } = getCredentials();

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
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
  };
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
    throw new Error(`Google token refresh failed: ${err}`);
  }

  const data = await res.json();

  return {
    access_token: data.access_token,
    refresh_token: refreshToken, // Keep original refresh token
    expires_at: Date.now() + data.expires_in * 1000,
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
    tokens = await refreshTokens(tokens.refresh_token);
    await onRefresh(encryptTokens(tokens));
  }

  return tokens.access_token;
}
