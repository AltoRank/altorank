import { describe, expect, it } from "vitest";
import { acceptableRedirectUri, redirectAllowed, registrationResponse, validateRegistration } from "../clients";

describe("dynamic client registration", () => {
  it("accepts https and loopback http, refuses everything else", () => {
    expect(acceptableRedirectUri("https://chatgpt.com/connector_platform_oauth_redirect")).toBe(true);
    expect(acceptableRedirectUri("http://localhost:6274/oauth/callback")).toBe(true);
    expect(acceptableRedirectUri("http://127.0.0.1:3000/cb")).toBe(true);
    expect(acceptableRedirectUri("http://evil.example/cb")).toBe(false);
    expect(acceptableRedirectUri("https://ok.example/cb#frag")).toBe(false);
    expect(acceptableRedirectUri("javascript:alert(1)")).toBe(false);
    expect(acceptableRedirectUri("not a url")).toBe(false);
  });

  it("registers a public client with the metadata a connector sends", () => {
    const out = validateRegistration({
      client_name: "ChatGPT",
      redirect_uris: ["https://chatgpt.com/cb", "https://chatgpt.com/cb"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      extra_field: "ignored",
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.client.client_name).toBe("ChatGPT");
    expect(out.client.redirect_uris).toEqual(["https://chatgpt.com/cb"]);
    expect(out.client.id.length).toBeGreaterThan(20);
    const res = registrationResponse(out.client);
    expect(res.token_endpoint_auth_method).toBe("none");
    expect(res.grant_types).toEqual(["authorization_code"]);
  });

  it("names the failing redirect and refuses secrets-based auth", () => {
    const bad = validateRegistration({ redirect_uris: ["https://a.example/cb", "http://b.example/cb"] });
    expect(bad).toMatchObject({ ok: false, error: "invalid_redirect_uri" });
    if (!bad.ok) expect(bad.description).toContain("http://b.example/cb");
    expect(validateRegistration({ redirect_uris: [] })).toMatchObject({ ok: false, error: "invalid_client_metadata" });
    expect(validateRegistration({ redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "client_secret_basic" })).toMatchObject({ ok: false });
    expect(validateRegistration({ redirect_uris: ["https://a.example/cb"], response_types: ["token"] })).toMatchObject({ ok: false });
  });

  it("redirect matching is exact", () => {
    const client = { id: "c", client_name: "x", redirect_uris: ["https://a.example/cb"] };
    expect(redirectAllowed(client, "https://a.example/cb")).toBe(true);
    expect(redirectAllowed(client, "https://a.example/cb?x=1")).toBe(false);
    expect(redirectAllowed(client, "https://a.example/cb/")).toBe(false);
  });
});
