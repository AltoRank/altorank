// ---------------------------------------------------------------------------
// Discovery documents for the hosted MCP endpoint
// ---------------------------------------------------------------------------
//
// Two documents, both derived from one base URL so they cannot disagree:
//
//   /.well-known/oauth-authorization-server   RFC 8414: where to register,
//                                             authorize and get a token
//   /.well-known/oauth-protected-resource     RFC 9728: which authorization
//                                             server protects /api/mcp
//
// MCP clients start from the 401 the resource returns (its WWW-Authenticate
// names the resource document), read that, then read the server document.
// Everything a client needs to connect without a human pasting a key is here.

import { ALL_SCOPES } from "@/lib/agent/api-keys";

export const MCP_PATH = "/api/mcp";

/** Scopes a connector may ask for; the same three the API keys page offers. */
export const OAUTH_SCOPES: readonly string[] = ALL_SCOPES;

export function resourceMetadataUrl(base: string): string {
  return `${base}/.well-known/oauth-protected-resource${MCP_PATH}`;
}

export function authorizationServerMetadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    registration_endpoint: `${base}/api/oauth/register`,
    scopes_supported: [...OAUTH_SCOPES],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    // Public clients only: a connector running inside ChatGPT or Claude has
    // nowhere to keep a secret, and PKCE binds the code to the caller instead.
    token_endpoint_auth_methods_supported: ["none"],
    service_documentation: "https://altorank.co/docs/mcp",
  };
}

export function protectedResourceMetadata(base: string) {
  return {
    resource: `${base}${MCP_PATH}`,
    authorization_servers: [base],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "AltoRank MCP server",
    resource_documentation: "https://altorank.co/docs/mcp",
  };
}

/** The header a 401 from the resource carries so a client can find the documents. */
export function wwwAuthenticate(base: string, error?: "invalid_token" | "insufficient_scope"): string {
  const parts = [`Bearer resource_metadata="${resourceMetadataUrl(base)}"`];
  if (error) parts.push(`error="${error}"`);
  return parts.join(", ");
}
