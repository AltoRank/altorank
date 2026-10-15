import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeSupabase } from "@/lib/agent/__tests__/fake-supabase";
import type { SupabaseClient } from "@supabase/supabase-js";

const getValidAccessToken = vi.fn();
vi.mock("@/lib/google/oauth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/google/oauth")>();
  return { ...real, getValidAccessToken: (...args: unknown[]) => getValidAccessToken(...args) };
});
vi.mock("@/lib/google/gsc", () => ({
  fetchGSCDailyTotals: vi.fn(async () => ({ clicks: 0, impressions: 0 })),
  fetchGSCPageMetrics: vi.fn(async () => []),
  fetchGSCQueryMetrics: vi.fn(async () => []),
  fetchGSCQueryPageMetrics: vi.fn(async () => []),
  listGSCSites: vi.fn(async () => []),
  matchGSCSite: vi.fn(() => null),
  gscPropertyCovers: () => true,
}));
vi.mock("@/lib/google/ga4", () => ({ fetchGA4Metrics: vi.fn(async () => []) }));

import { GoogleReconnectError } from "@/lib/google/oauth";
import { syncWorkspaceAnalytics, NEEDS_RECONNECT_MESSAGE, type SyncableIntegration } from "../sync";

const WS = "11111111-1111-4111-8111-111111111111";

function integration(over: Partial<SyncableIntegration> = {}): SyncableIntegration {
  return {
    id: "wi-gsc",
    tokens: { encrypted: "blob" },
    config: { gscSiteUrl: "sc-domain:acme.co" },
    workspace: { id: WS, domain: "acme.co" },
    needs_reconnect: false,
    ...over,
  };
}

function db() {
  return fakeSupabase({
    workspace_integrations: [
      { id: "wi-gsc", workspace_id: WS, integration_id: "gsc", needs_reconnect: false, last_sync_error: null },
      { id: "wi-ga4", workspace_id: WS, integration_id: "ga4", needs_reconnect: false, last_sync_error: null },
      { id: "wi-other", workspace_id: "22222222-2222-4222-8222-222222222222", integration_id: "gsc", needs_reconnect: false, last_sync_error: null },
    ],
    articles: [],
    analytics_metrics: [],
  });
}

beforeEach(() => getValidAccessToken.mockReset());

describe("syncWorkspaceAnalytics and a refused token", () => {
  it("marks the row whose token was refused needs_reconnect and says so in the result", async () => {
    getValidAccessToken.mockRejectedValueOnce(new GoogleReconnectError("Google no longer accepts this connection's refresh token (400: invalid_grant). Reconnect Google to resume syncing."));
    const supabase = db();
    const r = await syncWorkspaceAnalytics(supabase as unknown as SupabaseClient, integration(), "2026-09-05");
    expect(r.needsReconnect).toBe(true);
    expect(r.error).toContain("Reconnect Google");
    const rows = supabase.tables.workspace_integrations;
    expect(rows.find((x) => x.id === "wi-gsc")).toMatchObject({ needs_reconnect: true, last_sync_error: expect.stringContaining("invalid_grant") });
    // Another workspace's connection is untouched: the flag is per row.
    expect(rows.find((x) => x.id === "wi-other")).toMatchObject({ needs_reconnect: false });
    const updates = supabase.writes.filter((w) => w.op === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0].filters).toEqual([{ kind: "eq", col: "id", value: "wi-gsc" }]);
  });

  it("leaves the site's GA4 row alone when the Search Console token is refused", async () => {
    // A GA4 connect by a Google user who never granted Search Console writes
    // only the ga4 row, so the two rows hold different people's tokens. One
    // person's refusal says nothing about the other's grant.
    getValidAccessToken.mockRejectedValueOnce(new GoogleReconnectError("Google no longer accepts this connection's refresh token (400: invalid_grant). Reconnect Google to resume syncing."));
    const supabase = db();
    await syncWorkspaceAnalytics(supabase as unknown as SupabaseClient, integration(), "2026-09-05");
    expect(supabase.tables.workspace_integrations.find((x) => x.id === "wi-ga4")).toMatchObject({
      needs_reconnect: false,
      last_sync_error: null,
    });
  });

  it("marks only the GA4 row when it is the GA4 row's token that was refused", async () => {
    getValidAccessToken.mockRejectedValueOnce(new GoogleReconnectError("Google no longer accepts this connection's refresh token (400: invalid_grant). Reconnect Google to resume syncing."));
    const supabase = db();
    const r = await syncWorkspaceAnalytics(
      supabase as unknown as SupabaseClient,
      integration({ id: "wi-ga4", config: { ga4PropertyId: "42" } }),
      "2026-09-05",
    );
    expect(r.needsReconnect).toBe(true);
    const rows = supabase.tables.workspace_integrations;
    expect(rows.find((x) => x.id === "wi-ga4")).toMatchObject({ needs_reconnect: true });
    expect(rows.find((x) => x.id === "wi-gsc")).toMatchObject({ needs_reconnect: false, last_sync_error: null });
  });

  it("does not mark the row for a transient failure", async () => {
    getValidAccessToken.mockRejectedValueOnce(new Error("Google token refresh failed: 503"));
    const supabase = db();
    const r = await syncWorkspaceAnalytics(supabase as unknown as SupabaseClient, integration(), "2026-09-05");
    expect(r.needsReconnect).toBeUndefined();
    expect(r.error).toContain("503");
    // The failure is recorded as the last sync's error, and nothing more: the
    // row is not marked for a reconnect, and tomorrow's run tries again.
    const updates = supabase.writes.filter((w) => w.op === "update");
    expect(updates.map((w) => Object.keys(w.patch!))).toEqual([["last_sync_error"]]);
    expect(supabase.tables.workspace_integrations.find((x) => x.id === "wi-gsc")).toMatchObject({ needs_reconnect: false, last_sync_error: expect.stringContaining("503") });
  });

  it("does not ask Google again while the row is flagged", async () => {
    const supabase = db();
    const r = await syncWorkspaceAnalytics(supabase as unknown as SupabaseClient, integration({ needs_reconnect: true }), "2026-09-05");
    expect(getValidAccessToken).not.toHaveBeenCalled();
    expect(r).toEqual({ workspaceId: WS, ga4: 0, gsc: 0, error: NEEDS_RECONNECT_MESSAGE, needsReconnect: true });
  });

  it("syncs as before when the token is accepted", async () => {
    getValidAccessToken.mockResolvedValueOnce("access");
    const supabase = db();
    const r = await syncWorkspaceAnalytics(supabase as unknown as SupabaseClient, integration(), "2026-09-05");
    expect(r.error).toBeUndefined();
    expect(r.needsReconnect).toBeUndefined();
    expect(supabase.tables.workspace_integrations.find((x) => x.id === "wi-gsc")).toMatchObject({ needs_reconnect: false });
  });
});
