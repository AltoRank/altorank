import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A first look does not wait for the speed test.
 *
 * Google's PageSpeed answers in up to a minute a try, twice, and nothing in
 * the keyword work or the plan reads it; on a production first look
 * (2026-10-09) it was most of the minute and a half before any keyword work
 * began. With `deferPageSpeed` the analysis returns without it, the audit is
 * stored with the test pending, and the result is written onto that row when
 * it answers (`pageSpeedSettled`). Without it, nothing changes.
 */

const { speed, updates } = vi.hoisted(() => ({
  speed: { release: null as null | ((v: unknown) => void) },
  updates: [] as Array<{ table: string; patch: Record<string, unknown>; id?: unknown }>,
}));

vi.mock("@/lib/e2e/stubs", () => ({ e2eStubsEnabled: () => false, stubAnalyseDomain: vi.fn() }));
vi.mock("../agent-readiness", () => ({ recordingFetcher: () => Object.assign(async () => ({ status: 0, headers: {}, body: "" }), { resources: new Map() }), runAgentReadiness: async () => ({ error: "not run in this test", score: 0, findings: [] }) }));
vi.mock("../crawler", () => ({ crawlSite: async () => [], usablePages: () => [] }));
vi.mock("../pagespeed", () => ({ fetchPageSpeedDetailed: () => new Promise((r) => { speed.release = r; }) }));
vi.mock("@/lib/cms/detect", () => ({ detectPlatform: async () => null }));
vi.mock("@/lib/seo/client", () => ({ hasDataForSEOCredentials: () => false }));

import { analyseDomain, SPEED_PENDING } from "../domain-analysis";

function supabase() {
  return {
    from: (table: string) => ({
      select: () => ({ eq: () => Object.assign(Promise.resolve({ data: [] }), { single: async () => ({ data: { business_profile: null } }) }) }),
      insert: () => Object.assign(Promise.resolve({ error: null }), {
        select: () => ({ maybeSingle: async () => ({ data: { id: "audit-1" }, error: null }) }),
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: async (_c: string, id: unknown) => { updates.push({ table, patch, id }); return { error: null }; },
      }),
      upsert: async () => ({ error: null }),
    }),
  } as never;
}

const RESULT = { performanceScore: 71, largestContentfulPaint: 2100, cumulativeLayoutShift: 0.01 };

beforeEach(() => {
  speed.release = null;
  updates.length = 0;
});

describe("the speed test on a first look", () => {
  it("is not waited for: the audit is stored pending, and the result lands on that row when it answers", async () => {
    const analysis = await analyseDomain({ domain: "acme-shop.example", supabase: supabase(), workspaceId: "w", deferPageSpeed: true });
    expect(analysis.pagespeed).toEqual({ unavailable: SPEED_PENDING });
    expect(analysis.layers.find((l) => l.id === "pagespeed")).toMatchObject({ status: "unavailable", detail: SPEED_PENDING });
    expect(updates.filter((u) => u.table === "domain_audits")).toEqual([]);
    speed.release!({ ok: true, result: RESULT });
    await analysis.pageSpeedSettled;
    expect(updates.filter((u) => u.table === "domain_audits")).toEqual([{ table: "domain_audits", patch: { pagespeed: RESULT }, id: "audit-1" }]);
  });

  it("is waited for, as before, when not deferred", async () => {
    let done = false;
    const pending = analyseDomain({ domain: "acme-shop.example", supabase: supabase(), workspaceId: "w" }).then((a) => { done = true; return a; });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    speed.release!({ ok: true, result: RESULT });
    const analysis = await pending;
    expect(analysis.pagespeed).toMatchObject({ performanceScore: 71 });
    expect(analysis.pageSpeedSettled).toBeUndefined();
  });
});
