// ---------------------------------------------------------------------------
// Dynamic client registration (RFC 7591) and redirect-URI checks
// ---------------------------------------------------------------------------
//
// Anyone may register a client: that is the point of the RFC, and it is how
// ChatGPT and Claude connect without a human copying ids between two
// settings pages. Registration grants nothing. A client still has to send a
// person to /oauth/authorize, where an owner or admin of an account decides.
//
// What registration does pin down is the redirect_uri: the code goes only to
// an address the client declared, over https (or loopback for local agents).

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { opaqueToken } from "./pkce";

export type OAuthClient = { id: string; client_name: string; redirect_uris: string[] };

const MAX_REDIRECTS = 10;

export function acceptableRedirectUri(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  // Local agents (Claude Code, Cursor, an MCP inspector) listen on loopback.
  if (url.protocol === "http:") return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  return false;
}

export const registrationSchema = z
  .object({
    client_name: z.string().trim().min(1).max(120).optional(),
    redirect_uris: z.array(z.string().trim().min(1).max(2048)).min(1).max(MAX_REDIRECTS),
    token_endpoint_auth_method: z.enum(["none"]).optional(),
    grant_types: z.array(z.string()).optional(),
    response_types: z.array(z.string()).optional(),
  })
  .passthrough();

export type RegistrationInput = z.infer<typeof registrationSchema>;

export type RegistrationOutcome =
  | { ok: true; client: OAuthClient }
  | { ok: false; error: "invalid_client_metadata" | "invalid_redirect_uri"; description: string };

export function validateRegistration(body: unknown): RegistrationOutcome {
  const parsed = registrationSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: "invalid_client_metadata", description: parsed.error.issues[0]?.message ?? "Malformed registration." };
  }
  const bad = parsed.data.redirect_uris.find((u) => !acceptableRedirectUri(u));
  if (bad) {
    return { ok: false, error: "invalid_redirect_uri", description: `redirect_uri must be https (or http on localhost): ${bad}` };
  }
  if (parsed.data.grant_types?.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
    return { ok: false, error: "invalid_client_metadata", description: "Only the authorization_code grant is supported." };
  }
  if (parsed.data.response_types?.some((r) => r !== "code")) {
    return { ok: false, error: "invalid_client_metadata", description: "Only the code response type is supported." };
  }
  return {
    ok: true,
    client: {
      id: opaqueToken(24),
      client_name: parsed.data.client_name ?? "MCP client",
      redirect_uris: Array.from(new Set(parsed.data.redirect_uris)),
    },
  };
}

/** The registration response, RFC 7591 §3.2.1. */
export function registrationResponse(client: OAuthClient) {
  return {
    client_id: client.id,
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
    client_id_issued_at: Math.floor(Date.now() / 1000),
  };
}

export async function saveClient(supabase: SupabaseClient, client: OAuthClient): Promise<void> {
  const { error } = await supabase.from("oauth_clients").insert({
    id: client.id,
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
  });
  if (error) throw new Error(`Could not register client: ${error.message}`);
}

export async function loadClient(supabase: SupabaseClient, id: string): Promise<OAuthClient | null> {
  if (!id || id.length > 200) return null;
  const { data } = await supabase.from("oauth_clients").select("id, client_name, redirect_uris").eq("id", id).maybeSingle();
  if (!data) return null;
  return { id: data.id, client_name: data.client_name, redirect_uris: data.redirect_uris ?? [] };
}

/** Exact string match, RFC 6749 §3.1.2.3. No prefix matching, no query-string leniency. */
export function redirectAllowed(client: OAuthClient, redirectUri: string): boolean {
  return client.redirect_uris.includes(redirectUri);
}
