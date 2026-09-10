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
let accountRows: Record<string, Row> = {};
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
      if (table === "accounts") {
        const id = filters.find((f) => f[0] === "id")?.[2] as string;
        return resolve({ data: single ? (accountRows[id] ?? null) : Object.values(accountRows), error: null });
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
  accountRows = {};
  resumedIds = [];
  update.mockReset();
  update.mockResolvedValue({});
});

describe("resumePausedWorkspaces", () => {
  it("resumes only the rows the account pause set, to `on`", async () => {
    resumedIds = ["ws-1", "ws-2"];
    const ids = await resumePausedWorkspaces(supabase, "account-1");
    expect(ids).toEqual(["ws-1", "ws-2"]);
    expect(writes).toHaveLength(1);
    expect(writes[0].row).toEqual({ status: "on", paused_until: null });
    expect(writes[0].filters).toEqual([
      ["account_id", "eq", "account-1"],
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

  it("resumes each account once and tells Stripe to collect again", async () => {
    dueRows = [{ account_id: "account-1" }, { account_id: "account-1" }, { account_id: "account-2" }];
    accountRows = {
      "account-1": { stripe_subscription_id: "sub_1" },
      "account-2": { stripe_subscription_id: null },
    };
    resumedIds = ["ws-1"];

    const outcomes = await resumeExpiredPauses(supabase, stripe, today);

    expect(writes.map((w) => w.filters[0])).toEqual([
      ["account_id", "eq", "account-1"],
      ["account_id", "eq", "account-2"],
    ]);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("sub_1", { pause_collection: "" });
    expect(outcomes).toEqual([
      { accountId: "account-1", workspaces: ["ws-1"], stripe: "lifted" },
      { accountId: "account-2", workspaces: ["ws-1"], stripe: "skipped" },
    ]);
  });

  it("reports a Stripe refusal after the rows are already resumed", async () => {
    dueRows = [{ account_id: "account-1" }];
    accountRows = { "account-1": { stripe_subscription_id: "sub_1" } };
    update.mockRejectedValue(new Error("No such subscription"));

    const outcomes = await resumeExpiredPauses(supabase, stripe, today);
    expect(writes).toHaveLength(1);
    expect(outcomes[0].stripe).toBe("No such subscription");
  });

  it("does not touch Stripe on a self-hosted install", async () => {
    dueRows = [{ account_id: "account-1" }];
    await resumeExpiredPauses(supabase, null, today);
    expect(writes).toHaveLength(1);
    expect(reads.filter((r) => r.table === "accounts")).toHaveLength(0);
  });
});

describe("isoDay", () => {
  it("is the UTC calendar day, the format paused_until is stored in", () => {
    expect(isoDay(new Date("2026-10-04T23:30:00Z"))).toBe("2026-10-04");
  });
});

describe("resumeExpiredPauses only lifts the pauses that have expired", () => {
  it("bounds the write by the same date it selected the account on", async () => {
    // It selects an account on the strength of *one* row whose date has passed,
    // then writes. Without the bound, that write cleared every billing-paused
    // row of the account - including a site paused for another three weeks.
    // `pauseAccount` writes the same date on every site, so the two are only
    // one hand-paused site apart rather than a live bug; the predicate should
    // still mean what its name says.
    dueRows = [{ account_id: "account-1" }];
    resumedIds = ["ws-1"];
    await resumeExpiredPauses(supabase, null, new Date("2026-10-04T00:00:00Z"));
    const workspaceWrite = writes.find((w) => w.table === "workspaces");
    expect(workspaceWrite?.filters).toContainEqual(["paused_until", "lte", "2026-10-04"]);
  });

  it("still resumes everything when the button asks, which has no date", async () => {
    // The Resume button and the webhook's "Stripe says the pause is cleared"
    // both mean all of it, whatever the dates say.
    await resumePausedWorkspaces(supabase, "account-1");
    const workspaceWrite = writes.find((w) => w.table === "workspaces");
    expect(workspaceWrite?.filters.map((f) => f[0])).not.toContain("paused_until_lte");
    expect(workspaceWrite?.filters.filter((f) => f[1] === "lte")).toHaveLength(0);
  });
});
