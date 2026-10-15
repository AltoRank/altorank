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
