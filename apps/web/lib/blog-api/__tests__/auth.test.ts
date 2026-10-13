import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeSupabase } from "@/lib/agent/__tests__/fake-supabase";
import { generateApiKey } from "@/lib/agent/api-keys";
import { BODY_LOCKED_MESSAGE } from "@/lib/billing/trial-refusal";

// ---------------------------------------------------------------------------
// The blog API asks the trial gate
// ---------------------------------------------------------------------------
//
// GET /api/blog/v1/articles/<slug> serves `status = 'live'` articles rendered
// to HTML, read with the service role. A signed-in person writes their own
// articles' status through PostgREST, so an account that had not started its
// trial could set its first draft to `live` and read the whole text back
// here. `live` is not proof anyone paid; the gate is.

const key = generateApiKey();
let gate: "open" | "gated" | "bypassed" = "open";
const asked: Array<[string, string | null]> = [];
vi.mock("@/lib/billing/body-lock", () => ({
  accountTrialGate: async (_sb: unknown, accountId: string, email: string | null) => {
    asked.push([accountId, email]);
    return gate;
  },
}));

const db = fakeSupabase({
  api_keys: [{ id: "k1", account_id: "acc-1", key_hash: key.hash, prefix: key.prefix, scopes: ["read"], revoked_at: null, expires_at: null }],
  accounts: [{ id: "acc-1", api_key: null }],
  workspaces: [{ id: "ws-1", account_id: "acc-1", domain: "acme-agency.example" }],
});
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => db }));

const { authenticateBlogRequest } = await import("../auth");

const req = () =>
  new Request("https://app.example/api/blog/v1/articles/some-slug?workspace_id=ws-1", {
    headers: { authorization: `Bearer ${key.key}` },
  });

beforeEach(() => {
  gate = "open";
  asked.length = 0;
});

describe("authenticateBlogRequest", () => {
  it("refuses a gated account with the body lock's sentence", async () => {
    gate = "gated";
    const auth = await authenticateBlogRequest(req());
    expect(auth.ok).toBe(false);
    if (auth.ok) return;
    expect(auth.response.status).toBe(403);
    expect(await auth.response.json()).toEqual({ error: BODY_LOCKED_MESSAGE });
    // A key is nobody's session: the bypass list is never consulted.
    expect(asked).toEqual([["acc-1", null]]);
  });

  it("lets an open account through to its workspace", async () => {
    const auth = await authenticateBlogRequest(req());
    expect(auth).toMatchObject({ ok: true, workspaceId: "ws-1" });
  });
});
