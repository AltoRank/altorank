/**
 * The refresh lease: one refresh per store at a time, a loser waits for the
 * winner's token, a revoked refresh token marks the store for reconnecting.
 *
 * The Supabase client is a small in-memory fake of the calls the module
 * makes; the refresh call to Shopify is mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { refreshAccessToken } = vi.hoisted(() => {
  process.env.ENCRYPTION_KEY = "0".repeat(64);
  process.env.SHOPIFY_API_KEY = "cid";
  process.env.SHOPIFY_API_SECRET = "shpss_secret";
  return { refreshAccessToken: vi.fn() };
});
vi.mock("../tokens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tokens")>()),
  refreshAccessToken,
}));

import { encrypt, decrypt } from "@/lib/crypto";
import { ShopifyRefreshRevokedError } from "../tokens";
import {
  installedAccessToken,
  markShopUninstalled,
  saveInstallationTokens,
  ShopifyNotInstalledError,
  ShopifyReauthRequiredError,
} from "../installations";

type Row = Record<string, unknown>;

function fakeSupabase(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    const rows = (tables[table] ??= []);
    let filters: Array<(r: Row) => boolean> = [];
    let op: { kind: "select" | "update" | "upsert" | "delete"; values?: Row } = { kind: "select" };
    const matching = () => rows.filter((r) => filters.every((f) => f(r)));
    const run = () => {
      if (op.kind === "update") {
        const hit = matching();
        for (const r of hit) Object.assign(r, op.values);
        return hit;
      }
      if (op.kind === "delete") {
        const hit = matching();
        tables[table] = rows.filter((r) => !hit.includes(r));
        return hit;
      }
      if (op.kind === "upsert") {
        const existing = rows.find((r) => r.shop_domain === op.values!.shop_domain);
        if (existing) {
          Object.assign(existing, op.values);
          return [existing];
        }
        const row = { id: `inst-${rows.length + 1}`, ...op.values };
        rows.push(row);
        return [row];
      }
      return matching();
    };
    const builder = {
      select: () => builder,
      update: (values: Row) => ((op = { kind: "update", values }), builder),
      upsert: (values: Row) => ((op = { kind: "upsert", values }), builder),
      delete: () => ((op = { kind: "delete" }), builder),
      eq: (col: string, val: unknown) => {
        const key = col.replace("config->>", "");
        filters.push((r) => (col.startsWith("config->>") ? (r.config as Row)?.[key] === val : r[col] === val));
        return builder;
      },
      or: (expr: string) => {
        // refreshing_until.is.null,refreshing_until.lt.<iso>
        const iso = expr.split("refreshing_until.lt.")[1];
        filters.push((r) => r.refreshing_until == null || String(r.refreshing_until) < iso);
        return builder;
      },
      single: async () => ({ data: run()[0] ?? null, error: null }),
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => void) => resolve({ data: run(), error: null }),
    };
    filters = [];
    return builder;
  };
  return { from } as never;
}

const HOUR = 3600_000;
const tokenSet = (access: string, refresh: string) => ({
  accessToken: access,
  accessExpiresAt: Date.now() + HOUR,
  refreshToken: refresh,
  refreshExpiresAt: Date.now() + 90 * 24 * HOUR,
  scopes: "read_content,write_content",
});

function installation(over: Row = {}): Row {
  return {
    id: "inst-1",
    shop_domain: "fern.myshopify.com",
    access_token: encrypt("tok_old"),
    access_expires_at: new Date(Date.now() + HOUR).toISOString(),
    refresh_token: encrypt("shprt_old"),
    refreshing_until: null,
    needs_reauth_at: null,
    uninstalled_at: null,
    ...over,
  };
}

beforeEach(() => refreshAccessToken.mockReset());

describe("installedAccessToken", () => {
  it("returns the stored token while it has more than five minutes left", async () => {
    const db = fakeSupabase({ shopify_installations: [installation()] });
    expect(await installedAccessToken(db, "inst-1")).toEqual({ shop: "fern.myshopify.com", token: "tok_old" });
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it("refreshes an expiring token under the lease and stores the rotated pair", async () => {
    const row = installation({ access_expires_at: new Date(Date.now() + 60_000).toISOString() });
    const db = fakeSupabase({ shopify_installations: [row] });
    refreshAccessToken.mockResolvedValueOnce(tokenSet("tok_new", "shprt_new"));

    expect((await installedAccessToken(db, "inst-1")).token).toBe("tok_new");
    expect(refreshAccessToken).toHaveBeenCalledWith("fern.myshopify.com", "shprt_old", { clientId: "cid", clientSecret: "shpss_secret" });
    expect(decrypt(row.refresh_token as string)).toBe("shprt_new");
    expect(row.refreshing_until).toBeNull();
  });

  it("never hands back the token a request just got a 401 with", async () => {
    const db = fakeSupabase({ shopify_installations: [installation()] });
    refreshAccessToken.mockResolvedValueOnce(tokenSet("tok_new", "shprt_new"));
    expect((await installedAccessToken(db, "inst-1", { rejectToken: "tok_old" })).token).toBe("tok_new");
  });

  it("waits for a refresh another request holds instead of refreshing too", async () => {
    vi.useFakeTimers();
    const row = installation({
      access_expires_at: new Date(Date.now() - 1000).toISOString(),
      refreshing_until: new Date(Date.now() + 30_000).toISOString(),
    });
    const db = fakeSupabase({ shopify_installations: [row] });

    const pending = installedAccessToken(db, "inst-1");
    await vi.advanceTimersByTimeAsync(500);
    // The other request finishes its refresh.
    Object.assign(row, {
      access_token: encrypt("tok_theirs"),
      access_expires_at: new Date(Date.now() + HOUR).toISOString(),
      refreshing_until: null,
    });
    await vi.advanceTimersByTimeAsync(500);

    expect((await pending).token).toBe("tok_theirs");
    expect(refreshAccessToken).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("marks the store for reconnecting when Shopify refuses the refresh token for good", async () => {
    const row = installation({ access_expires_at: new Date(Date.now() - 1000).toISOString() });
    const db = fakeSupabase({ shopify_installations: [row] });
    refreshAccessToken.mockRejectedValueOnce(new ShopifyRefreshRevokedError());

    await expect(installedAccessToken(db, "inst-1")).rejects.toBeInstanceOf(ShopifyReauthRequiredError);
    expect(row.needs_reauth_at).toEqual(expect.any(String));
    expect(row.refreshing_until).toBeNull();
    // And says so on the next call without asking Shopify again.
    await expect(installedAccessToken(db, "inst-1")).rejects.toBeInstanceOf(ShopifyReauthRequiredError);
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it("releases the lease on a transient failure so the next call can retry", async () => {
    const row = installation({ access_expires_at: new Date(Date.now() - 1000).toISOString() });
    const db = fakeSupabase({ shopify_installations: [row] });
    refreshAccessToken.mockRejectedValueOnce(new Error("Shopify token refresh failed (503)"));

    await expect(installedAccessToken(db, "inst-1")).rejects.toThrow(/503/);
    expect(row.refreshing_until).toBeNull();
    expect(row.needs_reauth_at).toBeNull();
  });

  it("refuses an uninstalled store", async () => {
    const db = fakeSupabase({ shopify_installations: [installation({ uninstalled_at: new Date().toISOString() })] });
    await expect(installedAccessToken(db, "inst-1")).rejects.toBeInstanceOf(ShopifyNotInstalledError);
  });
});

describe("install and uninstall", () => {
  it("a reinstall clears the uninstall and reconnect marks", async () => {
    const row = installation({ uninstalled_at: "2026-10-01T00:00:00Z", needs_reauth_at: "2026-10-01T00:00:00Z" });
    const db = fakeSupabase({ shopify_installations: [row] });
    expect(await saveInstallationTokens(db, "fern.myshopify.com", tokenSet("tok_a", "shprt_a"))).toEqual({ id: "inst-1" });
    expect(row.uninstalled_at).toBeNull();
    expect(row.needs_reauth_at).toBeNull();
    expect(decrypt(row.access_token as string)).toBe("tok_a");
  });

  it("uninstall drops the tokens and flags the connections that used them", async () => {
    const row = installation();
    const conn = { integration_id: "shopify", config: { installationId: "inst-1" }, needs_reconnect: false };
    const other = { integration_id: "shopify", config: { installationId: "inst-9" }, needs_reconnect: false };
    const db = fakeSupabase({ shopify_installations: [row], workspace_integrations: [conn, other] });

    await markShopUninstalled(db, "fern.myshopify.com");
    expect(row.access_token).toBeNull();
    expect(row.refresh_token).toBeNull();
    expect(row.uninstalled_at).toEqual(expect.any(String));
    expect(conn.needs_reconnect).toBe(true);
    expect(other.needs_reconnect).toBe(false);
  });
});
