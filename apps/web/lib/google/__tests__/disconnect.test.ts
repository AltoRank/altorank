import { beforeAll, describe, expect, it, vi } from "vitest";
import { encryptTokens } from "@/lib/google/oauth";
import { GOOGLE_REVOKE_URL, disconnectGoogleForAccount, revokeGoogleToken } from "@/lib/google/disconnect";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = "0".repeat(64);
});

const stored = (refresh: string) => ({ encrypted: encryptTokens({ access_token: "a", refresh_token: refresh, expires_at: 0 }) });

/** A service client over in-memory tables that records deletes. */
function fakeAdmin(tables: Record<string, Record<string, unknown>[]>) {
  const deletes: { table: string; ids: unknown[] }[] = [];
  const from = (table: string) => {
    const filters: [string, "eq" | "in", unknown][] = [];
    let deleting = false;
    const rows = () =>
      (tables[table] ?? []).filter((r) =>
        filters.every(([col, op, v]) => (op === "eq" ? r[col] === v : (v as unknown[]).includes(r[col]))),
      );
    const builder: Record<string, unknown> = {
      select: () => builder,
      delete: () => {
        deleting = true;
        return builder;
      },
      eq: (col: string, v: unknown) => {
        filters.push([col, "eq", v]);
        return builder;
      },
      in: (col: string, v: unknown[]) => {
        filters.push([col, "in", v]);
        return builder;
      },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => {
        if (deleting) {
          const gone = rows();
          deletes.push({ table, ids: gone.map((r) => r.id) });
          tables[table] = (tables[table] ?? []).filter((r) => !gone.includes(r));
          return resolve({ error: null });
        }
        return resolve({ data: rows(), error: null });
      },
    };
    return builder;
  };
  return { client: { from } as never, deletes, tables };
}

describe("disconnectGoogleForAccount", () => {
  it("deletes every site's Google rows and the account consent, then revokes each token once", async () => {
    const admin = fakeAdmin({
      workspaces: [
        { id: "ws-1", account_id: "acc-1" },
        { id: "ws-2", account_id: "acc-1" },
        { id: "ws-other", account_id: "acc-2" },
      ],
      workspace_integrations: [
        { id: "r1", workspace_id: "ws-1", integration_id: "gsc", tokens: stored("rt-1") },
        { id: "r2", workspace_id: "ws-2", integration_id: "gsc", tokens: stored("rt-1") },
        { id: "r3", workspace_id: "ws-2", integration_id: "ga4", tokens: stored("rt-1") },
        { id: "r4", workspace_id: "ws-1", integration_id: "wordpress", tokens: null },
        { id: "r5", workspace_id: "ws-other", integration_id: "gsc", tokens: stored("rt-9") },
      ],
      account_integrations: [
        { id: "c1", account_id: "acc-1", provider: "google", tokens: stored("rt-2") },
        { id: "c2", account_id: "acc-2", provider: "google", tokens: stored("rt-9") },
      ],
    });
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));

    const result = await disconnectGoogleForAccount(admin.client, "acc-1", fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ removedSiteConnections: 3, removedAccountConsent: true, revoked: 2, revokeFailed: 0 });
    expect(admin.tables.workspace_integrations.map((r) => r.id)).toEqual(["r4", "r5"]);
    expect(admin.tables.account_integrations.map((r) => r.id)).toEqual(["c2"]);
    const revokedTokens = fetchImpl.mock.calls.map((c) => {
      const [url, init] = c as unknown as [string, RequestInit];
      expect(url).toBe(GOOGLE_REVOKE_URL);
      return new URLSearchParams(init.body as URLSearchParams).get("token");
    });
    expect(revokedTokens.sort()).toEqual(["rt-1", "rt-2"]);
  });

  it("still removes the stored tokens when Google cannot be reached", async () => {
    const admin = fakeAdmin({
      workspaces: [{ id: "ws-1", account_id: "acc-1" }],
      workspace_integrations: [{ id: "r1", workspace_id: "ws-1", integration_id: "gsc", tokens: stored("rt-1") }],
      account_integrations: [],
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    const result = await disconnectGoogleForAccount(admin.client, "acc-1", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ removedSiteConnections: 1, removedAccountConsent: false, revoked: 0, revokeFailed: 1 });
    expect(admin.tables.workspace_integrations).toEqual([]);
  });
});

describe("revokeGoogleToken", () => {
  it("counts a token Google already considers dead as revoked", async () => {
    const dead = vi.fn(async () => new Response('{"error":"invalid_token"}', { status: 400 }));
    expect(await revokeGoogleToken("t", dead as unknown as typeof fetch)).toBe(true);
    const down = vi.fn(async () => new Response("oops", { status: 503 }));
    expect(await revokeGoogleToken("t", down as unknown as typeof fetch)).toBe(false);
  });
});
