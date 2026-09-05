import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  WORKSPACE_A,
  WORKSPACE_B,
  twoWorkspaces,
  makeClient,
  leaksOtherWorkspace,
  type Seed,
} from "@/lib/queries/__tests__/scope-fixture";

let seed: Seed = {};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => makeClient(seed),
}));

beforeEach(() => {
  seed = {
    analytics_metrics: twoWorkspaces(3, (workspace_id, i) => ({
      id: `am-${workspace_id.slice(0, 4)}-${i}`,
      workspace_id,
      source: "gsc",
      metric_date: "2026-09-01",
      clicks: 1,
      impressions: 10,
      avg_position: 5,
      page_url: i === 0 ? null : `https://${workspace_id.slice(0, 4)}.co/p${i}`,
      query: null,
      article_id: null,
      created_at: `2026-09-02T04:0${i}:00Z`,
    })),
    workspace_integrations: twoWorkspaces(1, (workspace_id) => ({
      id: `wi-${workspace_id.slice(0, 4)}`,
      workspace_id,
      integration_id: "gsc",
      connected_at: "2026-08-01T00:00:00Z",
      config: { gscSiteUrl: `sc-domain:${workspace_id.slice(0, 4)}.co` },
    })),
    articles: twoWorkspaces(2, (workspace_id, i) => ({
      id: `art-${workspace_id.slice(0, 4)}-${i}`,
      workspace_id,
      status: "live",
      title: `Article ${i}`,
      published_url: `https://${workspace_id.slice(0, 4)}.co/blog/${i}`,
      indexing_status: i === 0 ? { inspection: { verdict: "PASS", checkedAt: "2026-09-03T00:00:00Z" } } : null,
    })),
    site_pages: twoWorkspaces(2, (workspace_id, i) => ({
      id: `sp-${workspace_id.slice(0, 4)}-${i}`,
      workspace_id,
      url: `https://${workspace_id.slice(0, 4)}.co/page-${i}`,
      title: `Page ${i}`,
      page_type: i === 1 ? "listing" : "page",
    })),
  };
});

describe("loadGscRows", () => {
  it("returns only the workspace it was given", async () => {
    const { loadGscRows } = await import("../queries");
    const rows = await loadGscRows(WORKSPACE_A);
    expect(rows.length).toBe(3);
    expect(leaksOtherWorkspace(rows as Record<string, unknown>[], WORKSPACE_A)).toBe(false);
  });
  it("returns the second workspace when asked for it", async () => {
    const { loadGscRows } = await import("../queries");
    const rows = await loadGscRows(WORKSPACE_B);
    expect(rows.every((r) => (r as unknown as { workspace_id: string }).workspace_id === WORKSPACE_B)).toBe(true);
  });
});

describe("syncHealthFor", () => {
  it("reads the connection and the newest row for one workspace", async () => {
    const { syncHealthFor } = await import("../queries");
    const h = await syncHealthFor(WORKSPACE_A);
    expect(h.connected).toBe(true);
    expect(h.siteUrl).toBe("sc-domain:aaaa.co");
    expect(h.connectedAt).toBe("2026-08-01T00:00:00Z");
    expect(h.lastSyncAt).toMatch(/^2026-09-02T04:0/);
    expect(h.latestMetricDate).toBe("2026-09-01");
  });
  it("says never for a workspace with no rows", async () => {
    seed.analytics_metrics = [];
    seed.workspace_integrations = [];
    const { syncHealthFor } = await import("../queries");
    const h = await syncHealthFor(WORKSPACE_A);
    expect(h).toEqual({ connected: false, connectedAt: null, siteUrl: null, lastSyncAt: null, latestMetricDate: null });
  });
});

describe("knownPagesFor", () => {
  it("joins live articles and non-listing site pages for one workspace only", async () => {
    const { knownPagesFor } = await import("../queries");
    const pages = await knownPagesFor(WORKSPACE_A);
    expect(pages.map((p) => p.url)).toEqual(["https://aaaa.co/blog/0", "https://aaaa.co/blog/1", "https://aaaa.co/page-0"]);
    expect(pages[0].articleId).toBe("art-aaaa-0");
    expect(pages[0].inspection?.verdict).toBe("PASS");
    expect(pages[1].inspection).toBeNull();
    expect(pages[2].articleId).toBeNull();
  });
});
