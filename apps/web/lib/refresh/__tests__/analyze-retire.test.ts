import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fakeSupabase, type FakeSupabase } from "@/lib/agent/__tests__/fake-supabase";

// ---------------------------------------------------------------------------
// A pass retires the candidates its numbers no longer support
// ---------------------------------------------------------------------------
//
// analyzeWorkspace used to insert new candidates and refresh the ones that
// fired again, and nothing else. A page that recovered stayed flagged with
// the old, undated evidence, and a rewrite scheduled on it still ran.

const { readGsc } = vi.hoisted(() => ({ readGsc: vi.fn() }));
vi.mock("@/lib/gsc/read", () => ({ readGsc: (...a: unknown[]) => readGsc(...a) }));

const { analyzeWorkspace } = await import("../detect");

const NOW = new Date("2026-10-16T08:00:00Z");
const day = "2026-10-10";

/** One query row in the current window. */
const row = (query: string, position: number, impressions: number, clicks = 5) => ({
  metric_date: day,
  query,
  page_url: null,
  article_id: null,
  clicks,
  impressions,
  avg_position: position,
});

const evidence = { query: "x", position: 9, prev_position: null, clicks: 1, prev_clicks: null, impressions: 300, ctr: 0.01, expected_ctr: null, word_count: 1500 };

function seed(): FakeSupabase {
  return fakeSupabase({
    workspace_integrations: [{ id: "i1", workspace_id: "ws1", integration_id: "gsc", tokens: { a: 1 } }],
    articles: [
      { id: "a1", workspace_id: "ws1", status: "live", keyword: "booking software", word_count: 1500, published_url: "https://acme.example/booking" },
      { id: "a2", workspace_id: "ws1", status: "live", keyword: "gym scheduling", word_count: 1500, published_url: "https://acme.example/gym" },
    ],
    site_pages: [],
    keywords: [],
    refresh_candidates: [
      // Still on page two: fires again.
      { id: "keep", workspace_id: "ws1", url: "https://acme.example/booking", opportunity: "almost_there", evidence, dismissed_at: null, created_at: "2026-09-01T00:00:00Z" },
      // Now ranks third: no longer "almost there".
      { id: "recovered", workspace_id: "ws1", url: "https://acme.example/gym", opportunity: "almost_there", evidence, dismissed_at: null, created_at: "2026-09-01T00:00:00Z" },
      // Not one of the site's pages any more.
      { id: "gone", workspace_id: "ws1", url: "https://acme.example/old", opportunity: "thin", evidence, dismissed_at: null, created_at: "2026-09-01T00:00:00Z" },
    ],
    refresh_tasks: [
      { id: "t-recovered", candidate_id: "recovered", workspace_id: "ws1", status: "scheduled", scheduled_for: "2026-10-20", created_at: "2026-10-01T00:00:00Z" },
      { id: "t-keep", candidate_id: "keep", workspace_id: "ws1", status: "scheduled", scheduled_for: "2026-10-20", created_at: "2026-10-01T00:00:00Z" },
    ],
    workspaces: [{ id: "ws1" }],
  });
}

/** The same fake, as a database where migration 117 has not been applied. */
function before117(f: FakeSupabase): FakeSupabase {
  const from = (table: string) => {
    const b = f.from(table) as Record<string, unknown>;
    let missing = false;
    const update = b.update as (...a: unknown[]) => unknown;
    const select = b.select as (...a: unknown[]) => unknown;
    const then = b.then as (...a: unknown[]) => unknown;
    b.update = (patch: Record<string, unknown>, ...rest: unknown[]) => {
      if ("resolved_at" in patch || "started_at" in patch) missing = true;
      else update(patch, ...rest);
      return b;
    };
    b.select = (cols?: string, ...rest: unknown[]) => {
      if (cols?.includes("started_at")) missing = true;
      select(cols, ...rest);
      return b;
    };
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      missing
        ? Promise.resolve({ data: null, error: { code: "PGRST204", message: "column missing" } }).then(resolve, reject)
        : then(resolve, reject);
    return b;
  };
  return { ...f, from } as FakeSupabase;
}

const run = (f: FakeSupabase) =>
  analyzeWorkspace(f as unknown as SupabaseClient, "ws1", { now: NOW, readBodies: async () => [] });

const byId = (f: FakeSupabase, table: string) => Object.fromEntries(f.tables[table].map((r) => [r.id, r]));

beforeEach(() => {
  readGsc.mockReset().mockResolvedValue({
    query: [row("booking software", 9, 400), row("gym scheduling", 3, 400, 120)],
    query_page: [],
  });
});

describe("analyzeWorkspace retires what no longer fires", () => {
  it("closes a recovered candidate and one whose page is gone, and cancels their tasks", async () => {
    const f = seed();
    const out = await run(f);
    expect(out).toMatchObject({ reason: "ok", retired: 2 });

    const cands = byId(f, "refresh_candidates");
    expect(cands.keep.dismissed_at).toBeNull();
    expect(cands.recovered).toMatchObject({ dismissed_at: NOW.toISOString(), resolved_at: NOW.toISOString() });
    expect(cands.gone).toMatchObject({ dismissed_at: NOW.toISOString(), resolved_at: NOW.toISOString() });

    const tasks = byId(f, "refresh_tasks");
    expect(tasks["t-recovered"].status).toBe("cancelled");
    expect(tasks["t-keep"].status).toBe("scheduled");
  });

  it("dates the evidence it writes", async () => {
    const f = seed();
    await run(f);
    expect((byId(f, "refresh_candidates").keep.evidence as { as_of?: string }).as_of).toBe("2026-10-16");
  });

  it("retires nothing when the window holds no Search Console rows", async () => {
    readGsc.mockResolvedValue({ query: [], query_page: [] });
    const f = seed();
    const out = await run(f);
    expect(out).toMatchObject({ reason: "ok", retired: 0 });
    expect(f.tables.refresh_candidates.every((c) => c.dismissed_at === null)).toBe(true);
    expect(byId(f, "refresh_tasks")["t-recovered"].status).toBe("scheduled");
  });

  it("still retires before migration 117, with dismissed_at alone", async () => {
    const f = seed();
    const out = await run(before117(f));
    expect(out).toMatchObject({ reason: "ok", retired: 2 });
    const cands = byId(f, "refresh_candidates");
    expect(cands.recovered.dismissed_at).toBe(NOW.toISOString());
    expect(cands.recovered.resolved_at).toBeUndefined();
    expect(byId(f, "refresh_tasks")["t-recovered"].status).toBe("cancelled");
  });
});
