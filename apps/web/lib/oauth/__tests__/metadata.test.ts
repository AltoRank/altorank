import { describe, expect, it } from "vitest";
import { authorizationServerMetadata, protectedResourceMetadata, resourceMetadataUrl, wwwAuthenticate } from "../metadata";

describe("discovery documents", () => {
  const base = "https://app.altorank.co";
  it("point at each other and at /api/mcp", () => {
    const as = authorizationServerMetadata(base);
    expect(as.issuer).toBe(base);
    expect(as.registration_endpoint).toBe(`${base}/api/oauth/register`);
    expect(as.token_endpoint).toBe(`${base}/api/oauth/token`);
    expect(as.authorization_endpoint).toBe(`${base}/oauth/authorize`);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.token_endpoint_auth_methods_supported).toEqual(["none"]);
    const pr = protectedResourceMetadata(base);
    expect(pr.resource).toBe(`${base}/api/mcp`);
    expect(pr.authorization_servers).toEqual([base]);
    expect(pr.scopes_supported).toEqual(["read", "generate", "write"]);
  });
  it("401 header names the path-form resource document", () => {
    expect(resourceMetadataUrl(base)).toBe(`${base}/.well-known/oauth-protected-resource/api/mcp`);
    expect(wwwAuthenticate(base, "invalid_token")).toBe(`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/api/mcp", error="invalid_token"`);
  });
});
