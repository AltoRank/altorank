import type { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { loadClient, redirectAllowed } from "@/lib/oauth/clients";
import { exchangeCode } from "@/lib/oauth/codes";
import { oauthError, oauthJson, readBody } from "@/lib/oauth/http";
import { announceApiKeyCreated } from "@/lib/email/account-events";
import { takeToolRateLimit } from "@/lib/tools/rate-limit";
import { clientIp } from "@/lib/growth-plan/http";

/**
 * POST /api/oauth/token — authorization_code grant with PKCE (RFC 7636).
 *
 * Public clients only (no client_secret). The verifier proves the caller is
 * the one that started the flow; the registered redirect_uri proves where the
 * code went. What comes back is an API key with the scopes the person
 * approved, so lib/agent/auth.ts needs no OAuth branch at all.
 */
export async function POST(request: NextRequest) {
  const limit = takeToolRateLimit("oauth-token", clientIp(request.headers), 60, 60 * 60 * 1000);
  if (!limit.allowed) return oauthError("too_many_requests", "Too many token requests from this address; try again later.", 429);

  const body = await readBody(request);
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");

  if (str("grant_type") !== "authorization_code") {
    return oauthError("unsupported_grant_type", "Only authorization_code is supported; there is no refresh token. Re-authorize when the token expires.");
  }
  const clientId = str("client_id");
  const redirectUri = str("redirect_uri");
  const codeVerifier = str("code_verifier");
  if (!clientId || !redirectUri || !codeVerifier) {
    return oauthError("invalid_request", "client_id, redirect_uri and code_verifier are required.");
  }

  const supabase = createServiceClient();
  const client = await loadClient(supabase, clientId);
  if (!client) return oauthError("invalid_client", "Unknown client_id; register first.", 401);
  if (!redirectAllowed(client, redirectUri)) return oauthError("invalid_grant", "redirect_uri is not registered for this client.");

  const outcome = await exchangeCode(supabase, {
    code: str("code"),
    clientId,
    redirectUri,
    codeVerifier,
    clientName: client.client_name,
  });
  if (!outcome.ok) return oauthError(outcome.error, outcome.description, 400);

  // Same notice a hand-made key sends: the other owners and admins learn a
  // credential now exists, and which connector holds it. Value not included.
  await announceApiKeyCreated({
    accountId: outcome.key.accountId,
    keyId: outcome.key.id,
    keyName: `${client.client_name} (connector)`,
    prefix: outcome.key.prefix,
    createdBy: client.client_name,
    canWrite: outcome.key.scopes.includes("write"),
    expiresAt: outcome.key.expiresAt,
  });

  return oauthJson(outcome.token, 200);
}
