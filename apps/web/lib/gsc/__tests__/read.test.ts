// What readGsc asks the database for, against a stub. Whether Postgres then
// answers correctly is read.db.test.ts's job; this pins the two things a stub
// can prove: which filters go on the query, and when it refuses to query.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readGsc } from "../read";

type Call = [string, ...unknown[]];

/** Records every builder call; returns no rows. */
function recorder() {
  const queries: Call[][] = [];
  const client = {
    from: (table: string) => {
      const calls: Call[] = [["from", table]];
      queries.push(calls);
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "gte", "lte", "not", "is", "order", "range"]) {
        q[m] = (...args: unknown[]) => (calls.push([m, ...args]), q);
      }
      q.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null, count: 0 });
      return q;
    },
  };
  return { client: client as unknown as SupabaseClient, queries };
}

const base = { shapes: ["total"] as const, since: "2026-09-01", until: "2026-09-02", columns: ["clicks"] as const };

describe("readGsc's workspace scope", () => {
  it("scopes every shape's query to the workspace it was given", async () => {
    const { client, queries } = recorder();
    await readGsc(client, { ...base, shapes: ["total", "query"], workspaceId: "ws-1" });
    expect(queries).toHaveLength(2);
    for (const calls of queries) expect(calls).toContainEqual(["eq", "workspace_id", "ws-1"]);
  });

  it("null, and only null, is the account-wide read with no workspace filter", async () => {
    const { client, queries } = recorder();
    await readGsc(client, { ...base, workspaceId: null });
    expect(queries[0].some(([m, col]) => m === "eq" && col === "workspace_id")).toBe(false);
  });

  it.each([
    ["an empty string", ""],
    ["whitespace", "  "],
    ["undefined through a cast", undefined as unknown as string],
  ])("refuses %s instead of reading every workspace", async (_label, workspaceId) => {
    // On a service-role client the unscoped read is every account's Search
    // Console; the old per-caller `.eq("workspace_id", "")` failed in Postgres,
    // and this keeps that failure rather than widening it.
    const { client, queries } = recorder();
    await expect(readGsc(client, { ...base, workspaceId })).rejects.toThrow(/workspaceId/);
    expect(queries).toHaveLength(0);
  });
});
