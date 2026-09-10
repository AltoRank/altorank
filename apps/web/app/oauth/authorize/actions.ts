"use server";

import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth/require-auth";
import { createServiceClient } from "@/lib/supabase/server";
import { loadClient, redirectAllowed } from "@/lib/oauth/clients";
import { issueCode, parseScopes } from "@/lib/oauth/codes";
import type { ApiKeyScope } from "@/lib/agent/api-keys";

// ---------------------------------------------------------------------------
// The consent decision
// ---------------------------------------------------------------------------
//
// Re-validates everything the page validated: a form post is a fresh request
// and the hidden fields are just fields. The code goes to the redirect_uri
// only after the client and that exact uri are confirmed registered, so a
// tampered form cannot send a code somewhere else.

function withParams(uri: string, params: Record<string, string | undefined>): string {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  return url.toString();
}

export async function decideAuthorization(formData: FormData): Promise<void> {
  const clientId = String(formData.get("client_id") ?? "");
  const redirectUri = String(formData.get("redirect_uri") ?? "");
  const state = String(formData.get("state") ?? "") || undefined;
  const codeChallenge = String(formData.get("code_challenge") ?? "");
  const decision = String(formData.get("decision") ?? "");
  const allowWrite = formData.get("allow_write") === "on";

  const supabase = createServiceClient();
  const client = await loadClient(supabase, clientId);
  if (!client || !redirectAllowed(client, redirectUri)) {
    redirect("/oauth/authorize?error=bad_client");
  }

  if (decision !== "approve") {
    redirect(withParams(redirectUri, { error: "access_denied", state }));
  }
  if (!/^[A-Za-z0-9\-_]{43}$/.test(codeChallenge)) {
    redirect(withParams(redirectUri, { error: "invalid_request", error_description: "code_challenge missing or not S256", state }));
  }

  // Owner or admin, same rule as making a key by hand. A member who got this
  // far sees the explanation on the page; the action just refuses.
  const { user, accountId } = await requireAuth(["owner", "admin"]);

  const { scopes: requested } = parseScopes(String(formData.get("scope") ?? ""));
  const scopes: ApiKeyScope[] = requested.filter((s) => s !== "write" || allowWrite);

  const code = await issueCode(supabase, {
    clientId,
    redirectUri,
    codeChallenge,
    scopes,
    accountId,
    userId: user.id,
  });

  redirect(withParams(redirectUri, { code, state }));
}
