import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// The account pause leaked two ways through site-level doors:
// - the per-site Resume lifted it for one site, which then drafted again while
//   Stripe kept voiding the invoices, and the Billing page lost the pause once
//   every site was resumed;
// - a site added during the pause drafted normally.

vi.mock("@/lib/onboarding/plan", () => ({ schedulePlan: vi.fn(async () => []) }));

type Row = Record<string, unknown>;
let siteRow: Row | null = null;
let pausedRows: Row[] = [];
const updates: Row[] = [];
const inserts: Row[] = [];
const pauseFilters: [string, unknown][] = [];

function client(): SupabaseClient {
  return {
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        select: () => q,
        eq: (c: string, v: unknown) => (table === "workspaces" && pauseFilters.push([`eq ${c}`, v]), q),
        gt: (c: string, v: unknown) => (pauseFilters.push([`gt ${c}`, v]), q),
        order: () => q,
        limit: async () => ({ data: pausedRows, error: null }),
        maybeSingle: async () => ({ data: table === "account_members" ? { role: "owner", workspace_ids: null } : siteRow, error: null }),
        single: async () => ({ data: { id: "ws-new" }, error: null }),
        update: (row: Row) => (updates.push(row), q),
        insert: (row: Row) => (inserts.push(row), q),
        then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
      });
      return q;
    },
  } as unknown as SupabaseClient;
}

vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => client() }));

beforeEach(() => {
  siteRow = null;
  pausedRows = [];
  updates.length = 0;
  inserts.length = 0;
  pauseFilters.length = 0;
});

describe("resumeWorkspace and the account pause", () => {
  it("refuses a site paused by the account pause, and points at Billing", async () => {
    siteRow = { id: "ws-1", status: "paused", paused_meta: null, paused_until: "2026-12-01", auto_generate_weekly_limit: 7 };
    const { resumeWorkspace } = await import("../pause");
    await expect(resumeWorkspace(client(), "acc-1", "ws-1")).rejects.toThrow(/paused with the whole account until December 1, 2026.*Billing page/);
    expect(updates).toEqual([]);
  });

  it("still resumes a site paused by hand", async () => {
    siteRow = { id: "ws-1", status: "paused", paused_meta: { previous_status: "on" }, paused_until: null, auto_generate_weekly_limit: 7 };
    const { resumeWorkspace } = await import("../pause");
    const out = await resumeWorkspace(client(), "acc-1", "ws-1");
    expect(out.changed).toBe(true);
    expect(updates[0]).toEqual({ status: "on", paused_meta: null });
  });
});

describe("adding a site during the account pause", () => {
  it("is refused until the pause is lifted, with the date", async () => {
    pausedRows = [{ paused_until: "2026-12-01" }];
    const { insertWorkspaceAsServer } = await import("../insert");
    const out = await insertWorkspaceAsServer(client(), "u-1", "acc-1", { domain: "new.example" });
    expect(out).toEqual({ ok: false, error: expect.stringMatching(/paused until December 1, 2026.*Resume the account on the Billing page/) });
    expect(inserts).toEqual([]);
    // Only a pause still running counts: one whose date has passed is over.
    expect(pauseFilters).toContainEqual(["eq status", "paused"]);
    expect(pauseFilters.some(([f]) => f === "gt paused_until")).toBe(true);
  });

  it("goes ahead when the account is not paused", async () => {
    const { insertWorkspaceAsServer } = await import("../insert");
    expect(await insertWorkspaceAsServer(client(), "u-1", "acc-1", { domain: "new.example" })).toEqual({ ok: true, id: "ws-new" });
    expect(inserts).toEqual([{ domain: "new.example", account_id: "acc-1" }]);
  });
});
