import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isReturnVisit, recordGateVisit, RETURN_AFTER_MS, returningToGate, visitDay } from "../gate-visits";

const NOW = new Date("2026-10-29T09:00:00.000Z");

/** A client that records the chain asked of it and answers with `answer`. */
function client(answer: { data: unknown; error: { message: string } | null }) {
  const calls: Array<[string, ...unknown[]]> = [];
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "lte", "order", "limit", "upsert"]) q[m] = (...args: unknown[]) => { calls.push([m, ...args]); return q; };
  q.maybeSingle = async () => answer;
  q.then = (resolve: (v: unknown) => unknown) => resolve(answer);
  return { db: { from: (t: string) => { calls.push(["from", t]); return q; } } as unknown as SupabaseClient, calls };
}

describe("gate visits", () => {
  it("is a return from 12 hours after a recorded visit, not before", () => {
    expect(isReturnVisit(null, NOW)).toBe(false);
    expect(isReturnVisit(new Date(NOW.getTime() - RETURN_AFTER_MS + 60_000).toISOString(), NOW)).toBe(false);
    expect(isReturnVisit(new Date(NOW.getTime() - RETURN_AFTER_MS).toISOString(), NOW)).toBe(true);
    expect(isReturnVisit("not a date", NOW)).toBe(false);
  });

  it("records one row per site per UTC day", async () => {
    const { db, calls } = client({ data: [{ day: "2026-10-29" }], error: null });
    expect(await recordGateVisit(db, { workspaceId: "ws", accountId: "acc" }, NOW)).toBe(true);
    const upsert = calls.find((c) => c[0] === "upsert")!;
    expect(upsert[1]).toEqual({ workspace_id: "ws", account_id: "acc", day: "2026-10-29", seen_at: NOW.toISOString() });
    expect(upsert[2]).toEqual({ onConflict: "workspace_id,day", ignoreDuplicates: true });
    expect(visitDay(new Date("2026-10-29T23:59:59Z"))).toBe("2026-10-29");
  });

  it("never throws, and a missing table greets nobody", async () => {
    expect(await recordGateVisit(client({ data: null, error: { message: "relation does not exist" } }).db, { workspaceId: "ws", accountId: "acc" }, NOW)).toBe(false);
    expect(await returningToGate(client({ data: null, error: { message: "relation does not exist" } }).db, "ws", NOW)).toBe(false);
  });

  it("asks for this site's visits only, old enough to be a return", async () => {
    const { db, calls } = client({ data: { seen_at: "2026-10-25T18:00:00.000Z" }, error: null });
    expect(await returningToGate(db, "ws", NOW)).toBe(true);
    expect(calls).toContainEqual(["from", "gate_visits"]);
    expect(calls).toContainEqual(["eq", "workspace_id", "ws"]);
    expect(calls).toContainEqual(["lte", "seen_at", new Date(NOW.getTime() - RETURN_AFTER_MS).toISOString()]);
  });
});
