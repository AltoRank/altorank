import { describe, it, expect, vi } from "vitest";
import { fakeSupabase } from "./fake-supabase";
import { generateApiKey } from "../api-keys";

// ---------------------------------------------------------------------------
// The agent API refuses a blog key
// ---------------------------------------------------------------------------
//
// A blog key sits in a customer site's environment. It reads that site's
// published articles through /api/blog/v1; the agent API (and the hosted MCP,
// which calls this without a scope) must not take it for anything.

const blog = generateApiKey();
const agent = generateApiKey();

const db = fakeSupabase({
  api_keys: [
    { id: "k-blog", account_id: "acc-1", name: "Blog", key_hash: blog.hash, scopes: ["blog"], workspace_id: "ws-1", revoked_at: null, expires_at: null, last_used_at: null },
    { id: "k-agent", account_id: "acc-1", name: "Agent", key_hash: agent.hash, scopes: ["read", "generate"], revoked_at: null, expires_at: null, last_used_at: null },
  ],
});
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => db }));

const { authenticateAgentRequest } = await import("../auth");

const req = (key: string) => new Request("https://app.example/api/agent/v1/articles", { headers: { authorization: `Bearer ${key}` } });

describe("authenticateAgentRequest and blog keys", () => {
  it("refuses a blog key with no scope asked (the MCP path)", async () => {
    const out = await authenticateAgentRequest(req(blog.key));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.envelope.error.code).toBe("forbidden");
    expect(out.envelope.error.message).toMatch(/blog API/);
  });

  it("refuses a blog key for every agent scope", async () => {
    for (const scope of ["read", "generate", "write"] as const) {
      expect((await authenticateAgentRequest(req(blog.key), scope)).ok).toBe(false);
    }
  });

  it("does not count or stamp a refused blog key", async () => {
    expect(db.writes.filter((w) => w.table === "api_keys")).toHaveLength(0);
  });

  it("still takes an agent key", async () => {
    expect((await authenticateAgentRequest(req(agent.key), "read")).ok).toBe(true);
  });
});
