/**
 * The hosted MCP endpoint, end to end over HTTP semantics: a client that
 * sends no token gets the 401 with the discovery pointer; a client with a
 * good token can initialize and list the same 26 tools the stdio server has.
 * Auth is mocked at the module boundary (it needs a database); everything
 * from the bearer check to the JSON-RPC frames is the real code.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const authenticate = vi.fn();
vi.mock("@/lib/agent/auth", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/agent/auth")>();
  return { ...mod, authenticateAgentRequest: (...args: unknown[]) => authenticate(...args) };
});

const { POST } = await import("../route");

const KEY = "altorank_live_" + "a".repeat(40);
const ORIGIN = "https://app.altorank.test";

function rpc(body: unknown, token?: string): NextRequest {
  return new NextRequest(`${ORIGIN}/api/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const goodCtx = {
  ok: true,
  ctx: {
    supabase: {},
    key: { id: "key-1", name: "ChatGPT (connector)", scopes: ["read", "generate"], expires_at: null, last_used_at: null },
    accountId: "account-1",
    rate: { allowed: true, limit: 120, remaining: 119, resetAt: "2026-09-07T00:00:00Z" },
  },
};

beforeEach(() => {
  authenticate.mockReset();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", ORIGIN);
});

describe("POST /api/mcp", () => {
  it("answers 401 with the RFC 9728 pointer when no bearer token is sent", async () => {
    const res = await POST(rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp"`,
    );
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("answers 401 invalid_token for a key the agent API refuses", async () => {
    authenticate.mockResolvedValue({
      ok: false,
      envelope: { ok: false, error: { code: "unauthorized", message: "Unknown API key." }, agent_guidance: "" },
    });
    const res = await POST(rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, KEY));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("initializes and lists every tool for a good token", async () => {
    authenticate.mockResolvedValue(goodCtx);
    const init = await POST(
      rpc(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
        },
        KEY,
      ),
    );
    expect(init.status).toBe(200);
    const initBody = (await init.json()) as { result: { serverInfo: { name: string }; instructions: string } };
    expect(initBody.result.serverInfo.name).toBe("altorank");
    expect(initBody.result.instructions).toContain("hosted endpoint");

    // Stateless: the next request carries no session id and still works.
    const list = await POST(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, KEY));
    expect(list.status).toBe(200);
    const body = (await list.json()) as { result: { tools: { name: string; title?: string; annotations?: Record<string, boolean> }[] } };
    const names = body.result.tools.map((t) => t.name).sort();
    expect(names).toHaveLength(26);
    expect(names).toContain("altorank_whoami");
    expect(names).toContain("altorank_check_readiness");
    // The gate, checkable: no publish, approve or delete tool exists.
    expect(names.some((n) => /publish|approve|delete/.test(n) && n !== "altorank_retry_publish")).toBe(false);

    // Both connector directories (ChatGPT plugins, Claude connectors) reject
    // tools without a title and read-only / destructive hints.
    for (const t of body.result.tools as { name: string; title?: string; annotations?: Record<string, boolean> }[]) {
      expect(t.title, t.name).toBeTruthy();
      expect(typeof t.annotations?.readOnlyHint, t.name).toBe("boolean");
      expect(typeof t.annotations?.destructiveHint, t.name).toBe("boolean");
      expect(typeof t.annotations?.openWorldHint, t.name).toBe("boolean");
    }
    const ro = (n: string) => body.result.tools.find((t) => t.name === n)!.annotations!.readOnlyHint;
    expect(ro("altorank_whoami")).toBe(true);
    expect(ro("altorank_generate_draft")).toBe(false);
    expect(ro("altorank_remove_keywords_from_plan")).toBe(false);
  });
});
