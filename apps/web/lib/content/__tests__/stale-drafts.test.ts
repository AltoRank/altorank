import { describe, it, expect, vi } from "vitest";
import { sweepStaleDrafts, STALE_DRAFT_MS } from "../stale-drafts";

const NOW = Date.parse("2026-09-07T07:00:00Z");
const old = new Date(NOW - STALE_DRAFT_MS - 60_000).toISOString();
const fresh = new Date(NOW - 60_000).toISOString();

/** A supabase double: `drafts` is what the articles query returns, `jobs` the running jobs; writes are recorded. */
function fake(drafts: Array<{ id: string }>, jobs: Array<{ id: string; article_id: string; created_at: string }>) {
  const writes: Array<{ table: string; patch: Record<string, unknown>; ids: string[] }> = [];
  const chain = (result: unknown) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "lt", "in"]) q[m] = vi.fn(() => q);
    (q as { then: unknown }).then = (res: (v: unknown) => void) => res(result);
    return q;
  };
  const supabase = {
    from: vi.fn((table: string) => {
      if (table === "articles") {
        return {
          select: () => chain({ data: drafts }),
          update: (patch: Record<string, unknown>) => ({ in: (_c: string, ids: string[]) => { writes.push({ table, patch, ids }); return Promise.resolve({}); } }),
        };
      }
      return {
        select: () => chain({ data: jobs }),
        update: (patch: Record<string, unknown>) => ({ in: (_c: string, ids: string[]) => { writes.push({ table, patch, ids }); return Promise.resolve({}); } }),
      };
    }),
  };
  return { supabase: supabase as never, writes };
}

describe("sweepStaleDrafts", () => {
  it("marks an old draft with no running job as errored", async () => {
    const { supabase, writes } = fake([{ id: "a1" }], []);
    expect(await sweepStaleDrafts(supabase, "w1", NOW)).toEqual({ swept: ["a1"] });
    expect(writes).toEqual([{ table: "articles", patch: { status: "error", updated_at: new Date(NOW).toISOString() }, ids: ["a1"] }]);
  });

  it("leaves a draft alone while a recent job is still running for it", async () => {
    const { supabase, writes } = fake([{ id: "a1" }], [{ id: "j1", article_id: "a1", created_at: fresh }]);
    expect(await sweepStaleDrafts(supabase, "w1", NOW)).toEqual({ swept: [] });
    expect(writes).toEqual([]);
  });

  it("closes a job that has been 'running' longer than the window, along with its draft", async () => {
    const { supabase, writes } = fake([{ id: "a1" }], [{ id: "j1", article_id: "a1", created_at: old }]);
    expect(await sweepStaleDrafts(supabase, "w1", NOW)).toEqual({ swept: ["a1"] });
    expect(writes.map((w) => [w.table, w.patch.status, w.ids])).toEqual([
      ["articles", "error", ["a1"]],
      ["generation_jobs", "failed", ["j1"]],
    ]);
  });

  it("does nothing when nothing is drafting", async () => {
    const { supabase, writes } = fake([], []);
    expect(await sweepStaleDrafts(supabase, "w1", NOW)).toEqual({ swept: [] });
    expect(writes).toEqual([]);
    expect((supabase as { from: ReturnType<typeof vi.fn> }).from).toHaveBeenCalledTimes(1);
  });
});
