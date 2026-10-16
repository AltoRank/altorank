import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// "Send test" and Connect send requests to an address the person typed. Both
// ask for a member of the site being connected, refuse local and reserved
// addresses before any request (unless the install allows its own network),
// and "Send test" shows a vendor's answer briefly rather than in full.

const { requireAuth, testConnection } = vi.hoisted(() => ({
  requireAuth: vi.fn(async (_roles?: string[], _opts?: { workspaceId?: string }) => ({ accountId: "acc-1", role: "editor", user: { id: "u1" } })),
  testConnection: vi.fn(async () => ({ ok: true as boolean, error: undefined as string | undefined })),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/require-auth", () => ({ requireAuth }));
vi.mock("@/lib/cms/adapter", () => ({ resolveCMSAdapter: () => ({ testConnection }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: () => ({ upsert: async () => ({ error: null }) }) }),
}));

import { connectIntegration, testIntegrationConfig } from "../integrations";

const wp = (siteUrl: string) => ({ type: "wordpress", siteUrl, username: "u", applicationPassword: "p" }) as never;

beforeEach(() => {
  requireAuth.mockClear();
  testConnection.mockReset();
  testConnection.mockResolvedValue({ ok: true, error: undefined });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("testIntegrationConfig", () => {
  it("asks for a member of the site being connected", async () => {
    await testIntegrationConfig("ws-1", wp("https://blog.example.com"));
    expect(requireAuth).toHaveBeenCalledWith(undefined, { workspaceId: "ws-1" });
  });

  it("refuses a local or reserved address before any request", async () => {
    for (const url of ["http://127.0.0.1:8080", "http://10.0.0.5", "http://localhost", "http://169.254.169.254"]) {
      const r = await testIntegrationConfig("ws-1", wp(url));
      expect(r.ok, url).toBe(false);
    }
    expect(testConnection).not.toHaveBeenCalled();
  });

  it("lets a self-hosted install that allows its own network test a private address", async () => {
    vi.stubEnv("ALTORANK_ALLOW_PRIVATE_FETCH", "1");
    const r = await testIntegrationConfig("ws-1", wp("http://10.0.0.5"));
    expect(r.ok).toBe(true);
    expect(testConnection).toHaveBeenCalledOnce();
  });

  it("shows a long vendor answer briefly", async () => {
    testConnection.mockResolvedValue({ ok: false, error: `WordPress 500: ${"x".repeat(5000)}` });
    const r = await testIntegrationConfig("ws-1", wp("https://blog.example.com"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.length).toBeLessThanOrEqual(300);
      expect(r.error.startsWith("WordPress 500: ")).toBe(true);
    }
  });
});

describe("connectIntegration", () => {
  it("asks for a member of the site and refuses a local address", async () => {
    await expect(connectIntegration("ws-1", "wordpress", wp("http://127.0.0.1"))).rejects.toThrow(/public sites only/);
    expect(requireAuth).toHaveBeenCalledWith(undefined, { workspaceId: "ws-1" });
    expect(testConnection).not.toHaveBeenCalled();
  });
});
