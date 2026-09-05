import { describe, it, expect } from "vitest";
import { frozenEntryIds, frozenReason, readFrozenEntries, type FrozenCandidate } from "../frozen";

/**
 * Which planned keywords the plan cannot pay for. The boundary is the quota's
 * `remaining`, taken in scheduled order; it moves only when the allowance
 * does, so an upgrade thaws and a downgrade freezes with no row written.
 */

const e = (id: string, date: string, created = "2026-09-01T00:00:00Z"): FrozenCandidate => ({ id, scheduled_date: date, created_at: created });

const plan = [e("c", "2026-09-12"), e("a", "2026-09-10"), e("d", "2026-09-13"), e("b", "2026-09-11")];
const noPlan = (remaining: number) => ({ limit: 1, remaining, reason: "no-plan" as const });
const managed = (remaining: number) => ({ limit: 100, remaining, reason: "plan" as const });

describe("frozenEntryIds", () => {
  it("freezes everything beyond the allowance, in scheduled order", () => {
    expect([...frozenEntryIds(plan, managed(2))].sort()).toEqual(["c", "d"]);
    expect([...frozenEntryIds(plan, noPlan(1))].sort()).toEqual(["b", "c", "d"]);
  });

  it("freezes nothing while the allowance covers the plan", () => {
    expect(frozenEntryIds(plan, managed(4)).size).toBe(0);
    expect(frozenEntryIds(plan, managed(97)).size).toBe(0);
  });

  it("freezes all of it when nothing is left", () => {
    expect(frozenEntryIds(plan, noPlan(0)).size).toBe(4);
  });

  it("never freezes an unmetered account: self-host, operator, custom tier", () => {
    expect(frozenEntryIds(plan, { limit: null, remaining: null, reason: "self-host" }).size).toBe(0);
    expect(frozenEntryIds(plan, { limit: null, remaining: null, reason: "operator" }).size).toBe(0);
    expect(frozenEntryIds(plan, null).size).toBe(0);
  });

  it("thaws on its own when the allowance grows", () => {
    const before = frozenEntryIds(plan, noPlan(1));
    const after = frozenEntryIds(plan, managed(100));
    expect(before.size).toBe(3);
    expect(after.size).toBe(0);
  });

  it("keeps the boundary where it was as active entries get written", () => {
    // Writing "a" removes it from the unwritten list and spends one draft.
    // The same two keywords stay frozen; nobody's square changed colour.
    const before = frozenEntryIds(plan, managed(2));
    const after = frozenEntryIds(plan.filter((x) => x.id !== "a"), managed(1));
    expect([...before].sort()).toEqual([...after].sort());
  });

  it("breaks a same-day tie by creation, then id, so two entries on one day freeze deterministically", () => {
    const sameDay = [e("y", "2026-09-10", "2026-09-01T10:00:00Z"), e("x", "2026-09-10", "2026-09-01T09:00:00Z")];
    expect([...frozenEntryIds(sameDay, managed(1))]).toEqual(["y"]);
    const identical = [e("q", "2026-09-10"), e("p", "2026-09-10")];
    expect([...frozenEntryIds(identical, managed(1))]).toEqual(["q"]);
  });

  it("treats a fractional or negative remaining as the floor, never as more room", () => {
    expect(frozenEntryIds(plan, managed(1.9)).size).toBe(3);
    expect(frozenEntryIds(plan, managed(-3)).size).toBe(4);
  });
});

describe("frozenReason", () => {
  it("names the free tier's one draft, and says it is used once it is", () => {
    expect(frozenReason(noPlan(1))).toMatch(/free tier includes 1 draft/);
    expect(frozenReason(noPlan(0))).toMatch(/free draft is used/);
    expect(frozenReason(noPlan(0))).toMatch(/Billing/);
  });

  it("quotes the plan's included volume and the two ways out", () => {
    const r = frozenReason(managed(0));
    expect(r).toMatch(/100 included articles/);
    expect(r).toMatch(/Upgrade/);
    expect(r).toMatch(/next month/);
  });
});

describe("readFrozenEntries", () => {
  /** A client that records the chain and answers with `rows`. */
  function client(rows: FrozenCandidate[]) {
    const calls: Array<{ table: string; filters: Array<[string, ...unknown[]]> }> = [];
    return {
      calls,
      supabase: {
        from: (table: string) => {
          const call = { table, filters: [] as Array<[string, ...unknown[]]> };
          calls.push(call);
          const q = {
            select: () => q,
            eq: (...a: unknown[]) => { call.filters.push(["eq", ...a]); return q; },
            is: (...a: unknown[]) => { call.filters.push(["is", ...a]); return q; },
            then: (r: (v: { data: unknown; error: null }) => unknown) => r({ data: rows, error: null }),
          };
          return q;
        },
      } as never,
    };
  }

  it("reads nothing at all for an unmetered account", async () => {
    const { supabase, calls } = client(plan);
    const out = await readFrozenEntries(supabase, "ws1", { limit: null, remaining: null, reason: "self-host" });
    expect(out).toEqual({ ids: new Set(), reason: null });
    expect(calls).toHaveLength(0);
  });

  it("reads only this workspace's unwritten planned entries and freezes past the allowance", async () => {
    const { supabase, calls } = client(plan);
    const out = await readFrozenEntries(supabase, "ws1", managed(2));
    expect([...out.ids].sort()).toEqual(["c", "d"]);
    expect(out.reason).toMatch(/100 included/);
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("calendar_entries");
    expect(calls[0].filters).toEqual(
      expect.arrayContaining([["eq", "workspace_id", "ws1"], ["eq", "status", "queue"], ["is", "article_id", null]]),
    );
  });
});
