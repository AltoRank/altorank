import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeSupabase } from "@/lib/agent/__tests__/fake-supabase";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// A token without Analytics must not stop Search Console
// ---------------------------------------------------------------------------
//
// Search Console and Analytics are separate consents now, so a Google token
// can read one and not the other. A GA4 refusal used to throw out of the
// whole sync, Search Console included, with Google's raw 403 as the message.

vi.mock("@/lib/google/oauth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/google/oauth")>();
  return { ...real, getValidAccessToken: async () => "access" };
});

const fetchGSCDailyTotals = vi.fn(async () => ({ clicks: 4, impressions: 40, ctr: 0.1, position: 9 }));
vi.mock("@/lib/google/gsc", () => ({
  fetchGSCDailyTotals: () => fetchGSCDailyTotals(),
  fetchGSCPageMetrics: vi.fn(async () => []),
  fetchGSCQueryMetrics: vi.fn(async () => []),
  fetchGSCQueryPageMetrics: vi.fn(async () => []),
  listGSCSites: vi.fn(async () => []),
  matchGSCSite: vi.fn(() => null),
  gscPropertyCovers: () => true,
}));

const fetchGA4Metrics = vi.fn();
vi.mock("@/lib/google/ga4", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/google/ga4")>();
  return { ...real, fetchGA4Metrics: (...args: unknown[]) => fetchGA4Metrics(...args) };
});

import { GA4_NOT_GRANTED_MESSAGE, GA4ScopeMissingError, isScopeInsufficient } from "../ga4";
import { syncWorkspaceAnalytics } from "../sync";

const WS = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  fetchGA4Metrics.mockReset();
  fetchGSCDailyTotals.mockClear();
});

describe("syncWorkspaceAnalytics with a token that lacks Analytics", () => {
  it("still pulls Search Console, and says to connect Google Analytics", async () => {
    fetchGA4Metrics.mockRejectedValueOnce(new GA4ScopeMissingError());
    const supabase = fakeSupabase({ workspace_integrations: [], articles: [], analytics_metrics: [] });
    const r = await syncWorkspaceAnalytics(
      supabase as unknown as SupabaseClient,
      {
        id: "wi-ga4",
        tokens: { encrypted: "blob" },
        config: { ga4PropertyId: "42", gscSiteUrl: "sc-domain:acme.co" },
        workspace: { id: WS, domain: "acme.co" },
        needs_reconnect: false,
      },
      "2026-10-10",
    );
    expect(fetchGSCDailyTotals).toHaveBeenCalled();
    expect(r.gsc).toBeGreaterThan(0);
    expect(r.ga4).toBe(0);
    expect(r.error).toBe(GA4_NOT_GRANTED_MESSAGE);
    expect(r.needsReconnect).toBeUndefined();
    // Nothing marks the Search Console connection as broken over it.
    expect(supabase.writes.filter((w) => w.table === "workspace_integrations")).toHaveLength(0);
  });
});

describe("isScopeInsufficient", () => {
  it("is Google's 403 for a scope the token was never granted", () => {
    const body = JSON.stringify({
      error: {
        code: 403,
        message: "Request had insufficient authentication scopes.",
        status: "PERMISSION_DENIED",
        details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
      },
    });
    expect(isScopeInsufficient(403, body)).toBe(true);
  });

  it("is not any other 403, or the same text on another status", () => {
    expect(isScopeInsufficient(403, JSON.stringify({ error: { message: "User does not have sufficient permissions for this property." } }))).toBe(false);
    expect(isScopeInsufficient(401, "insufficient authentication scopes")).toBe(false);
  });
});
