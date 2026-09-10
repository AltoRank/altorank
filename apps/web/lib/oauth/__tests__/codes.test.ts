import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fakeSupabase } from "@/lib/agent/__tests__/fake-supabase";
import { hashApiKey, looksLikeApiKey } from "@/lib/agent/api-keys";
import { CODE_TTL_MS, TOKEN_TTL_DAYS, exchangeCode, issueCode, parseScopes } from "../codes";
import { challengeFor, opaqueToken } from "../pkce";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

function world() {
  const fake = fakeSupabase({ oauth_clients: [{ id: "client-1", client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/cb"] }], oauth_codes: [], api_keys: [] });
  return { fake, supabase: fake as unknown as SupabaseClient };
}

const base = { clientId: "client-1", redirectUri: "https://chatgpt.com/cb", clientName: "ChatGPT" };

describe("parseScopes", () => {
  it("always includes the defaults, adds write only when asked, reports unknowns", () => {
    expect(parseScopes("")).toEqual({ scopes: ["read", "generate"], unknown: [] });
    expect(parseScopes("write")).toEqual({ scopes: ["read", "generate", "write"], unknown: [] });
    expect(parseScopes("read openid publish")).toEqual({ scopes: ["read", "generate"], unknown: ["openid", "publish"] });
  });
});

describe("authorization code exchange", () => {
  it("issues a code and exchanges it once for an API key with the approved scopes", async () => {
    const { fake, supabase } = world();
    const verifier = opaqueToken(48);
    const code = await issueCode(supabase, { ...base, codeChallenge: challengeFor(verifier), scopes: ["read", "generate"], accountId: ACCOUNT, userId: USER });

    const out = await exchangeCode(supabase, { ...base, code, codeVerifier: verifier });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(looksLikeApiKey(out.token.access_token)).toBe(true);
    expect(out.token.scope).toBe("read generate");
    expect(out.token.expires_in).toBeGreaterThan(TOKEN_TTL_DAYS * 24 * 3600 - 5);

    const keyRow = fake.tables.api_keys[0];
    expect(keyRow.key_hash).toBe(hashApiKey(out.token.access_token));
    expect(keyRow.account_id).toBe(ACCOUNT);
    expect(keyRow.oauth_client_id).toBe("client-1");
    expect(keyRow.name).toBe("ChatGPT (connector)");
    expect(keyRow.scopes).toEqual(["read", "generate"]);

    // Replay: the same code is burnt.
    const again = await exchangeCode(supabase, { ...base, code, codeVerifier: verifier });
    expect(again).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(fake.tables.api_keys).toHaveLength(1);
  });

  it("refuses a wrong verifier, a different client, a different redirect and an expired code", async () => {
    const { supabase } = world();
    const verifier = opaqueToken(48);
    const mint = () => issueCode(supabase, { ...base, codeChallenge: challengeFor(verifier), scopes: ["read", "generate", "write"], accountId: ACCOUNT, userId: USER });

    expect(await exchangeCode(supabase, { ...base, code: await mint(), codeVerifier: opaqueToken(48) })).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(await exchangeCode(supabase, { ...base, clientId: "client-2", code: await mint(), codeVerifier: verifier })).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(await exchangeCode(supabase, { ...base, redirectUri: "https://chatgpt.com/other", code: await mint(), codeVerifier: verifier })).toMatchObject({ ok: false, error: "invalid_grant" });

    const issuedAt = new Date("2026-09-07T10:00:00Z");
    const code = await issueCode(supabase, { ...base, codeChallenge: challengeFor(verifier), scopes: ["read"], accountId: ACCOUNT, userId: USER }, issuedAt);
    const late = new Date(issuedAt.getTime() + CODE_TTL_MS + 1);
    expect(await exchangeCode(supabase, { ...base, code, codeVerifier: verifier }, late)).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(await exchangeCode(supabase, { ...base, code: "nope", codeVerifier: verifier })).toMatchObject({ ok: false, error: "invalid_grant" });
  });
});
