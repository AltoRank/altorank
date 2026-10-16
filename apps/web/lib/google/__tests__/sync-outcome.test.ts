import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeSupabase } from "@/lib/agent/__tests__/fake-supabase";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// What one Search Console sync leaves behind
// ---------------------------------------------------------------------------

vi.mock("@/lib/google/oauth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/google/oauth")>();
  return { ...real, getValidAccessToken: async () => "access" };
});

const gsc = {
  totals: vi.fn(async (): Promise<unknown> => null),
  pages: vi.fn(async (): Promise<unknown[]> => []),
  sites: vi.fn(async (): Promise<unknown[]> => []),
};
vi.mock("@/lib/google/gsc", () => ({
  fetchGSCDailyTotals: () => gsc.totals(),
  fetchGSCPageMetrics: () => gsc.pages(),
  fetchGSCQueryMetrics: vi.fn(async () => []),
  fetchGSCQueryPageMetrics: vi.fn(async () => []),
  listGSCSites: () => gsc.sites(),
  matchGSCSite: vi.fn(() => null),
  gscPropertyCovers: (siteUrl: string) => siteUrl === "sc-domain:acme.co",
}));
vi.mock("@/lib/google/ga4", () => ({ fetchGA4Metrics: vi.fn(async () => []) }));

import { syncWorkspaceAnalytics, type SyncableIntegration } from "../sync";

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
    workspace_integrations: [{ id: "wi-gsc", workspace_id: WS, integration_id: "gsc", needs_reconnect: false, last_sync_error: null }],
    articles: [],
    analytics_metrics: [],
  });
}

beforeEach(() => {
  gsc.totals.mockReset().mockResolvedValue(null);
  gsc.pages.mockReset().mockResolvedValue([]);
  gsc.sites.mockReset().mockResolvedValue([]);
});

describe("storing a large day", () => {
  it("stores every row, in chunks a request can carry", async () => {
    gsc.pages.mockResolvedValue(
      Array.from({ length: 2_500 }, (_, i) => ({ pageUrl: `https://acme.co/p${i}`, clicks: 0, impressions: 1, ctr: 0, position: 30 })),
    );
    const supabase = db();
    const r = await syncWorkspaceAnalytics(supabase as unknown as SupabaseClient, integration(), "2026-10-01");
    expect(r.error).toBeUndefined();
    expect(r.gsc).toBe(2_500);
    expect(supabase.tables.analytics_metrics).toHaveLength(2_500);
    const inserts = supabase.writes.filter((w) => w.table === "analytics_metrics" && w.op === "insert");
    expect(inserts.map((w) => w.rows!.length)).toEqual([1_000, 1_000, 500]);
  });
});

describe("the recorded sync outcome", () => {
  const NOW = new Date();
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10);

  function withOutcome(over: Record<string, unknown> = {}) {
    return fakeSupabase({
      workspace_integrations: [
        { id: "wi-gsc", workspace_id: WS, integration_id: "gsc", needs_reconnect: false, last_sync_error: null, last_synced_at: null, synced_from: null, synced_through: null, ...over },
      ],
      articles: [],
      analytics_metrics: [],
    });
  }
  const gscRow = (s: ReturnType<typeof withOutcome>) => s.tables.workspace_integrations.find((r) => r.id === "wi-gsc")!;

  it("counts a day Google answered empty once it is past the publishing lag: a measured zero", async () => {
    const supabase = withOutcome();
    await syncWorkspaceAnalytics(supabase as unknown as SupabaseClient, integration(), daysAgo(5));
    expect(gscRow(supabase)).toMatchObject({ synced_from: daysAgo(5), synced_through: daysAgo(5) });
    expect(gscRow(supabase).last_synced_at).toEqual(expect.any(String));
  });

  it("does not count yesterday answered empty: Google may not have written it yet", async () => {
    const supabase = withOutcome({ synced_from: daysAgo(9), synced_through: daysAgo(5) });
    await syncWorkspaceAnalytics(supabase as unknown as SupabaseClient, integration(), daysAgo(1));
    expect(gscRow(supabase)).toMatchObject({ synced_from: daysAgo(9), synced_through: daysAgo(5) });
    // The sync still completed.
    expect(gscRow(supabase).last_synced_at).toEqual(expect.any(String));
  });

  it("counts a recent day that came back with rows, and widens the range both ways", async () => {
    gsc.totals.mockResolvedValue({ clicks: 1, impressions: 10, ctr: 0.1, position: 9 });
    const supabase = withOutcome({ synced_from: daysAgo(6), synced_through: daysAgo(4) });
    await syncWorkspaceAnalytics(supabase as unknown as SupabaseClient, integration(), daysAgo(1));
    await syncWorkspaceAnalytics(supabase as unknown as SupabaseClient, integration(), daysAgo(8));
    expect(gscRow(supabase)).toMatchObject({ synced_from: daysAgo(8), synced_through: daysAgo(1) });
  });

  it("writes no range on a database without migration 115, and still syncs", async () => {
    const supabase = fakeSupabase({
      workspace_integrations: [{ id: "wi-gsc", workspace_id: WS, integration_id: "gsc", needs_reconnect: false, last_sync_error: null }],
      articles: [],
      analytics_metrics: [],
    });
    gsc.totals.mockResolvedValue({ clicks: 1, impressions: 10, ctr: 0.1, position: 9 });
    const r = await syncWorkspaceAnalytics(supabase as unknown as SupabaseClient, integration(), daysAgo(5));
    expect(r.gsc).toBe(1);
    expect(supabase.writes.filter((w) => w.table === "workspace_integrations")).toHaveLength(0);
  });

  it("stores a missing-property failure on the row, where the product can say it", async () => {
    const supabase = withOutcome();
    const r = await syncWorkspaceAnalytics(supabase as unknown as SupabaseClient, integration({ config: { gscSiteUrl: "sc-domain:other.com" } }), daysAgo(5));
    expect(r.error).toMatch(/no Search Console property for acme\.co/);
    expect(gscRow(supabase)).toMatchObject({ last_sync_error: expect.stringMatching(/no Search Console property/), needs_reconnect: false, synced_through: null });
  });

  it("leaves the gsc row alone when the ga4 row's token drove the failing sync", async () => {
    // Connecting Analytics backfills from the ga4 row; that token may not see
    // Search Console at all. Its failure is not the gsc connection's.
    const supabase = fakeSupabase({
      workspace_integrations: [
        { id: "wi-gsc", workspace_id: WS, integration_id: "gsc", needs_reconnect: false, last_sync_error: null, last_synced_at: null, synced_from: daysAgo(30), synced_through: daysAgo(3) },
        { id: "wi-ga4", workspace_id: WS, integration_id: "ga4", needs_reconnect: false, last_sync_error: null },
      ],
      articles: [],
      analytics_metrics: [],
    });
    const r = await syncWorkspaceAnalytics(
      supabase as unknown as SupabaseClient,
      integration({ id: "wi-ga4", config: { gscSiteUrl: "sc-domain:other.com" } }),
      daysAgo(5),
    );
    expect(r.error).toMatch(/no Search Console property/);
    expect(gscRow(supabase).last_sync_error).toBeNull();
  });

  it("clears a stored failure once a sync succeeds", async () => {
    const supabase = withOutcome({ last_sync_error: "GSC API error (503)" });
    await syncWorkspaceAnalytics(supabase as unknown as SupabaseClient, integration(), daysAgo(5));
    expect(gscRow(supabase).last_sync_error).toBeNull();
  });

  it("leaves a refused token's message for the reconnect to clear", async () => {
    const supabase = withOutcome({ needs_reconnect: true, last_sync_error: "invalid_grant" });
    // The cron skips such a row; a row passed in by another caller with a stale flag still syncs.
    await syncWorkspaceAnalytics(supabase as unknown as SupabaseClient, integration({ needs_reconnect: false }), daysAgo(5));
    expect(gscRow(supabase).last_sync_error).toBe("invalid_grant");
  });
});

describe("dayAnswered", () => {
  it("is past the lag or has rows", async () => {
    const { dayAnswered } = await import("../sync");
    const now = new Date("2026-10-15T04:00:00Z");
    expect(dayAnswered("2026-10-14", 0, now)).toBe(false);
    expect(dayAnswered("2026-10-13", 0, now)).toBe(false);
    expect(dayAnswered("2026-10-12", 0, now)).toBe(true);
    expect(dayAnswered("2026-10-14", 5, now)).toBe(true);
  });
});
