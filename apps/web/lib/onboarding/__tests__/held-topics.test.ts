import { describe, expect, it } from "vitest";
import { heldTopics } from "../plan";
import { stateFromRun } from "../events";
import type { SupabaseClient } from "@supabase/supabase-js";

function client(count: number): SupabaseClient {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is"]) q[m] = () => Object.assign(Promise.resolve({ count, data: null, error: null }), q);
  return { from: () => q } as unknown as SupabaseClient;
}

describe("heldTopics", () => {
  it("counts the qualified topics the plan left out and places them on the pace grid after the plan", async () => {
    const out = await heldTopics(client(3), "ws", 3, ["2026-09-21"], new Date("2026-09-21T00:00:00Z"));
    expect(out.count).toBe(3);
    expect(out.dates).toHaveLength(3);
    expect(out.dates[0] > "2026-09-21").toBe(true);
    expect(new Set(out.dates).size).toBe(3);
  });
  it("is empty when nothing is held", async () => {
    expect(await heldTopics(client(0), "ws", 3, [])).toEqual({ count: 0, dates: [] });
  });
});

describe("stateFromRun", () => {
  const run = { id: "r", workspace_id: "ws", status: "done" as const, phases: [], planned: [{ term: "x", date: "2026-09-21" }], keywords_found: 1, article_id: null, error: null, started_at: "2026-09-21T00:00:00Z", updated_at: "2026-09-21T00:00:00Z", finished_at: null };
  it("carries the held topics the snapshot read", () => {
    expect(stateFromRun(run, null, { held: { count: 2, dates: ["2026-09-23", "2026-09-25"] } }).held).toEqual({ count: 2, dates: ["2026-09-23", "2026-09-25"] });
    expect(stateFromRun(run, null).held).toBeNull();
  });
});
