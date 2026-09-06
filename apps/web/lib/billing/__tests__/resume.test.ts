import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { isoDay, resumeExpiredPauses, resumePausedWorkspaces } from "../resume";

// ---------------------------------------------------------------------------
// The account pause ending on its own
// ---------------------------------------------------------------------------
//
// Stripe resumed charging on `resumes_at`; nothing resumed the workspaces, so
// a customer was billed for a month in which nothing was drafted. The generate
// cron now lifts every pause whose date has passed, with the same write the
// Resume button makes.

type Row = Record<string, unknown>;
type Filter = [string, string, unknown];

const writes: { table: string; row: Row; filters: Filter[] }[] = [];
const reads: { table: string; filters: Filter[] }[] = [];

/** Rows `select` returns per table, and ids `update ... select("id")` reports. */
let dueRows: Row[] = [];
let agencyRows: Record<string, Row> = {};
let resumedIds: string[] = [];

function query(table: string, op: "select" | "update", row?: Row) {
  const filters: Filter[] = [];
  let single = false;
  const q = {
    eq: (c: string, v: unknown) => (filters.push([c, "eq", v]), q),
    not: (c: string, o: string, v: unknown) => (filters.push([c, `not ${o}`, v]), q),
    lte: (c: string, v: unknown) => (filters.push([c, "lte", v]), q),
    select: () => q,
    single: () => ((single = true), q),
    maybeSingle: () => ((single = true), q),
    then: (resolve: (v: unknown) => unknown) => {
      if (op === "update") {
        writes.push({ table, row: row!, filters });
        return resolve({ data: resumedIds.map((id) => ({ id })), error: null });
      }
      reads.push({ table, filters });
      if (table === "agencies") {
        const id = filters.find((f) => f[0] === "id")?.[2] as string;
        return resolve({ data: single ? (agencyRows[id] ?? null) : Object.values(agencyRows), error: null });
      }
      return resolve({ data: dueRows, error: null });
    },
  };
  return q;
}

const supabase = {
  from: (table: string) => ({
    select: () => query(table, "select"),
    update: (row: Row) => query(table, "update", row),
  }),
} as unknown as SupabaseClient;

const update = vi.fn();
const stripe = { subscriptions: { update } } as unknown as Stripe;

beforeEach(() => {
  writes.length = 0;
  reads.length = 0;
  dueRows = [];
  agencyRows = {};
  resumedIds = [];
  update.mockReset();
  update.mockResolvedValue({});
});

describe("resumePausedWorkspaces", () => {
  it("resumes only the rows the account pause set, to `on`", async () => {
    resumedIds = ["ws-1", "ws-2"];
    const ids = await resumePausedWorkspaces(supabase, "agency-1");
    expect(ids).toEqual(["ws-1", "ws-2"]);
    expect(writes).toHaveLength(1);
    expect(writes[0].row).toEqual({ status: "on", paused_until: null });
    expect(writes[0].filters).toEqual([
      ["agency_id", "eq", "agency-1"],
      ["status", "eq", "paused"],
      // A site paused by hand carries no date and is left as its owner left it.
      ["paused_until", "not is", null],
    ]);
  });
});

describe("resumeExpiredPauses", () => {
  const today = new Date("2026-10-04T07:00:00Z");

  it("selects pauses whose date is today or earlier", async () => {
    await resumeExpiredPauses(supabase, stripe, today);
    expect(reads[0].table).toBe("workspaces");
    expect(reads[0].filters).toEqual([
      ["status", "eq", "paused"],
      ["paused_until", "not is", null],
      ["paused_until", "lte", "2026-10-04"],
    ]);
    expect(writes).toHaveLength(0);
    expect(update).not.toHaveBeenCalled();
  });

  it("resumes each agency once and tells Stripe to collect again", async () => {
    dueRows = [{ agency_id: "agency-1" }, { agency_id: "agency-1" }, { agency_id: "agency-2" }];
    agencyRows = {
      "agency-1": { stripe_subscription_id: "sub_1" },
      "agency-2": { stripe_subscription_id: null },
    };
    resumedIds = ["ws-1"];

    const outcomes = await resumeExpiredPauses(supabase, stripe, today);

    expect(writes.map((w) => w.filters[0])).toEqual([
      ["agency_id", "eq", "agency-1"],
      ["agency_id", "eq", "agency-2"],
    ]);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("sub_1", { pause_collection: "" });
    expect(outcomes).toEqual([
      { agencyId: "agency-1", workspaces: ["ws-1"], stripe: "lifted" },
      { agencyId: "agency-2", workspaces: ["ws-1"], stripe: "skipped" },
    ]);
  });

  it("reports a Stripe refusal after the rows are already resumed", async () => {
    dueRows = [{ agency_id: "agency-1" }];
    agencyRows = { "agency-1": { stripe_subscription_id: "sub_1" } };
    update.mockRejectedValue(new Error("No such subscription"));

    const outcomes = await resumeExpiredPauses(supabase, stripe, today);
    expect(writes).toHaveLength(1);
    expect(outcomes[0].stripe).toBe("No such subscription");
  });

  it("does not touch Stripe on a self-hosted install", async () => {
    dueRows = [{ agency_id: "agency-1" }];
    await resumeExpiredPauses(supabase, null, today);
    expect(writes).toHaveLength(1);
    expect(reads.filter((r) => r.table === "agencies")).toHaveLength(0);
  });
});

describe("isoDay", () => {
  it("is the UTC calendar day, the format paused_until is stored in", () => {
    expect(isoDay(new Date("2026-10-04T23:30:00Z"))).toBe("2026-10-04");
  });
});
