import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fakeSupabase, type FakeSupabase } from "@/lib/agent/__tests__/fake-supabase";
import {
  STALE_RUNNING_MS,
  STOPPED_MESSAGE,
  claimTask,
  closeOpenTasks,
  isOpenTask,
  isStaleRunning,
  readTasks,
  reapStoppedTasks,
} from "../tasks";

// ---------------------------------------------------------------------------
// A rewrite cut off mid-run must not stay "running" for good
// ---------------------------------------------------------------------------
//
// cron/refresh runs a rewrite inside a 300 s function. When the platform kills
// it before the rewrite records an outcome, the task stayed `running`: shown
// as "Rewriting now…", counted as a held slot, and out of reach of cancel,
// reschedule and dismiss.

const NOW = Date.parse("2026-10-16T08:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const task = (over: Record<string, unknown>) => ({
  id: "t1",
  candidate_id: "c1",
  workspace_id: "ws1",
  status: "scheduled",
  scheduled_for: "2026-10-16",
  created_at: ago(3 * 86_400_000),
  started_at: null,
  ...over,
});

const db = (f: FakeSupabase) => f as unknown as SupabaseClient;

/** The same fake, as a database where migration 117 has not been applied. */
function before117(f: FakeSupabase): FakeSupabase {
  const from = (table: string) => {
    const b = f.from(table) as Record<string, unknown>;
    if (table !== "refresh_tasks") return b;
    let missing = false;
    const select = b.select as (...a: unknown[]) => unknown;
    const update = b.update as (...a: unknown[]) => unknown;
    const then = b.then as (...a: unknown[]) => unknown;
    b.select = (cols?: string, ...rest: unknown[]) => {
      if (cols?.includes("started_at")) missing = true;
      select(cols, ...rest);
      return b;
    };
    b.update = (patch: Record<string, unknown>, ...rest: unknown[]) => {
      if ("started_at" in patch) missing = true;
      if (missing) return b;
      update(patch, ...rest);
      return b;
    };
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      missing
        ? Promise.resolve({ data: null, error: { code: "PGRST204", message: "no started_at" } }).then(resolve, reject)
        : then(resolve, reject);
    return b;
  };
  return { ...f, from } as FakeSupabase;
}

describe("isStaleRunning / isOpenTask", () => {
  it("a running task past the limit was cut off; one inside it is still running", () => {
    expect(isStaleRunning(task({ status: "running", started_at: ago(STALE_RUNNING_MS + 1000) }), NOW)).toBe(true);
    expect(isStaleRunning(task({ status: "running", started_at: ago(60_000) }), NOW)).toBe(false);
  });

  it("falls back to created_at when started_at is not recorded", () => {
    expect(isStaleRunning(task({ status: "running", started_at: undefined }), NOW)).toBe(true);
    expect(isStaleRunning(task({ status: "running", started_at: null, created_at: ago(60_000) }), NOW)).toBe(false);
  });

  it("only a running task can be stale", () => {
    expect(isStaleRunning(task({ status: "failed" }), NOW)).toBe(false);
    expect(isStaleRunning(task({ status: "done" }), NOW)).toBe(false);
  });

  it("open: waiting, failed or cut off - never done, cancelled or genuinely running", () => {
    expect(isOpenTask(task({ status: "scheduled" }), NOW)).toBe(true);
    expect(isOpenTask(task({ status: "failed" }), NOW)).toBe(true);
    expect(isOpenTask(task({ status: "running", started_at: ago(STALE_RUNNING_MS * 2) }), NOW)).toBe(true);
    expect(isOpenTask(task({ status: "running", started_at: ago(1000) }), NOW)).toBe(false);
    expect(isOpenTask(task({ status: "done" }), NOW)).toBe(false);
    expect(isOpenTask(task({ status: "cancelled" }), NOW)).toBe(false);
  });
});

describe("claimTask", () => {
  it("moves a scheduled task to running and stamps when", async () => {
    const f = fakeSupabase({ refresh_tasks: [task({})] });
    expect(await claimTask(db(f), "t1", new Date(NOW))).toBe(true);
    expect(f.tables.refresh_tasks[0]).toMatchObject({ status: "running", started_at: new Date(NOW).toISOString() });
  });

  it("does not claim a task that is no longer scheduled", async () => {
    const f = fakeSupabase({ refresh_tasks: [task({ status: "running", started_at: ago(1000) })] });
    expect(await claimTask(db(f), "t1", new Date(NOW))).toBe(false);
    expect(f.tables.refresh_tasks[0].started_at).toBe(ago(1000));
  });

  it("still claims before migration 117, without the stamp", async () => {
    const f = fakeSupabase({ refresh_tasks: [task({ started_at: undefined })] });
    expect(await claimTask(db(before117(f)), "t1", new Date(NOW))).toBe(true);
    expect(f.tables.refresh_tasks[0].status).toBe("running");
    expect(f.tables.refresh_tasks[0].started_at).toBeUndefined();
  });
});

describe("readTasks", () => {
  it("reads without started_at before migration 117", async () => {
    const f = fakeSupabase({ refresh_tasks: [task({ status: "running", started_at: undefined })] });
    const rows = await readTasks(db(before117(f)), { statuses: ["running"] });
    expect(rows.map((r) => r.id)).toEqual(["t1"]);
  });
});

describe("reapStoppedTasks", () => {
  it("fails only the running tasks that were cut off, and says so", async () => {
    const f = fakeSupabase({
      refresh_tasks: [
        task({ id: "stuck", status: "running", started_at: ago(STALE_RUNNING_MS + 60_000) }),
        task({ id: "live", status: "running", started_at: ago(30_000) }),
        task({ id: "waiting", status: "scheduled" }),
      ],
    });
    expect(await reapStoppedTasks(db(f), NOW)).toBe(1);
    const byId = Object.fromEntries(f.tables.refresh_tasks.map((t) => [t.id, t]));
    expect(byId.stuck).toMatchObject({ status: "failed", error: STOPPED_MESSAGE });
    expect(byId.live.status).toBe("running");
    expect(byId.waiting.status).toBe("scheduled");
  });

  it("works before migration 117, judging by created_at", async () => {
    const f = fakeSupabase({ refresh_tasks: [task({ id: "stuck", status: "running", started_at: undefined })] });
    expect(await reapStoppedTasks(db(before117(f)), NOW)).toBe(1);
    expect(f.tables.refresh_tasks[0].status).toBe("failed");
  });
});

describe("closeOpenTasks", () => {
  it("cancels waiting, failed and cut-off tasks, and leaves a live run alone", async () => {
    const f = fakeSupabase({
      refresh_tasks: [
        task({ id: "a", status: "scheduled" }),
        task({ id: "b", status: "failed" }),
        task({ id: "c", status: "running", started_at: ago(STALE_RUNNING_MS * 3) }),
        task({ id: "d", status: "running", started_at: ago(5_000) }),
        task({ id: "e", status: "done" }),
      ],
    });
    const rows = await readTasks(db(f), { statuses: ["scheduled", "failed", "running", "done"] });
    expect(await closeOpenTasks(db(f), rows, { status: "cancelled" }, NOW)).toBe(3);
    const status = Object.fromEntries(f.tables.refresh_tasks.map((t) => [t.id, t.status]));
    expect(status).toEqual({ a: "cancelled", b: "cancelled", c: "cancelled", d: "running", e: "done" });
  });

  it("leaves a task that moved after it was read", async () => {
    const f = fakeSupabase({ refresh_tasks: [task({ status: "scheduled" })] });
    const rows = await readTasks(db(f), { statuses: ["scheduled"] });
    f.tables.refresh_tasks[0].status = "running";
    f.tables.refresh_tasks[0].started_at = new Date(NOW).toISOString();
    expect(await closeOpenTasks(db(f), rows, { status: "cancelled" }, NOW)).toBe(0);
    expect(f.tables.refresh_tasks[0].status).toBe("running");
  });
});
