import { describe, it, expect } from "vitest";
import { lastEnabledDayBefore, rewriteSlot, runOrder, type DueTask, type RecentRun, type RewriteSlot } from "../schedule";

// 2026-10-12 is a Monday (UTC weekday 1).
const MON = new Date("2026-10-12T07:30:00Z");
const TUE = new Date("2026-10-13T07:30:00Z");
const WED = new Date("2026-10-14T07:30:00Z");

const task = (over: Partial<DueTask> = {}): DueTask => ({
  id: "t1",
  workspace_id: "ws1",
  scheduled_for: "2026-10-12",
  created_at: "2026-10-10T09:00:00Z",
  ...over,
});
const run = (created_at: string, workspace_id = "ws1"): RecentRun => ({ workspace_id, created_at });

describe("lastEnabledDayBefore", () => {
  it("finds the most recent enabled day before today", () => {
    expect(lastEnabledDayBefore([1], TUE)).toBe("2026-10-12");
    expect(lastEnabledDayBefore([1, 4], WED)).toBe("2026-10-12");
    expect(lastEnabledDayBefore([5], TUE)).toBe("2026-10-09");
  });

  it("never returns today, and nothing without days", () => {
    expect(lastEnabledDayBefore([2], TUE)).toBeNull();
    expect(lastEnabledDayBefore([], TUE)).toBeNull();
  });
});

describe("rewriteSlot", () => {
  it("runs the earliest due task on one of the site's days", () => {
    const due = [task({ id: "old", scheduled_for: "2026-10-05" }), task({ id: "new" })];
    expect(rewriteSlot({ days: [1], now: MON, due, runs: [] })).toEqual({ kind: "scheduled", task: due[0] });
  });

  it("one a day: not twice on the same day", () => {
    expect(rewriteSlot({ days: [1], now: MON, due: [task()], runs: [run("2026-10-12T07:31:00Z")] })).toMatchObject({
      kind: "none",
      reason: "already ran today",
    });
  });

  it("makes up a rewrite day the run's cap skipped, the next morning", () => {
    expect(rewriteSlot({ days: [1], now: TUE, due: [task()], runs: [] })).toEqual({
      kind: "catch_up",
      task: task(),
      missed: "2026-10-12",
    });
  });

  it("still makes it up the morning after, if that run was capped too", () => {
    expect(rewriteSlot({ days: [1], now: WED, due: [task()], runs: [] })).toMatchObject({ kind: "catch_up" });
  });

  it("does not make up a day that produced its rewrite", () => {
    expect(rewriteSlot({ days: [1], now: TUE, due: [task({ id: "next" })], runs: [run("2026-10-12T07:32:00Z")] })).toMatchObject({
      kind: "none",
    });
  });

  it("never exceeds the week's count", () => {
    // Mon and Thu: one rewrite in the trailing week (last Thursday's) and
    // Monday's missed, so one is owed. With two in the week, none is.
    const owed = rewriteSlot({ days: [1, 4], now: TUE, due: [task()], runs: [run("2026-10-08T07:30:00Z")] });
    expect(owed.kind).toBe("catch_up");
    const full = rewriteSlot({
      days: [1, 4],
      now: TUE,
      due: [task()],
      runs: [run("2026-10-08T07:30:00Z"), run("2026-10-09T07:30:00Z")],
    });
    expect(full.kind).toBe("none");
  });

  it("keeps a task added after its day began for the next enabled day", () => {
    const late = task({ created_at: "2026-10-12T10:00:00Z" });
    expect(rewriteSlot({ days: [1], now: TUE, due: [late], runs: [] }).kind).toBe("none");
  });

  it("keeps a task dated after the missed day for the next enabled day", () => {
    const later = task({ scheduled_for: "2026-10-13" });
    expect(rewriteSlot({ days: [1], now: TUE, due: [later], runs: [] }).kind).toBe("none");
  });

  it("nothing to do on another day with nothing missed", () => {
    expect(rewriteSlot({ days: [1], now: TUE, due: [], runs: [] })).toEqual({ kind: "none", reason: "not a scheduled day" });
  });
});

describe("runOrder", () => {
  const ws = (id: string, over: Record<string, unknown> = {}) => ({ id, refresh_days: [1], refresh_last_analyzed_at: "2026-10-12T07:30:00Z", ...over });
  const slot = (id: string, kind: "scheduled" | "catch_up" = "scheduled", scheduled_for = "2026-10-12"): [string, RewriteSlot] => [
    id,
    kind === "catch_up"
      ? { kind, task: task({ id: `t-${id}`, workspace_id: id, scheduled_for }), missed: "2026-10-12" }
      : { kind, task: task({ id: `t-${id}`, workspace_id: id, scheduled_for }) },
  ];

  it("puts the site the cap delayed last week ahead of the ones it did not", () => {
    // Last week ws3 was capped on Monday and caught up on Tuesday.
    const runs = [run("2026-10-05T07:30:00Z", "a"), run("2026-10-05T07:31:00Z", "b"), run("2026-10-06T07:30:00Z", "c")];
    const slots = new Map([slot("a"), slot("b"), slot("c")]);
    expect(runOrder([ws("a"), ws("b"), ws("c")], slots, runs).map((w) => w.id)).toEqual(["c", "a", "b"]);
  });

  it("a catch-up goes before the day's own sites", () => {
    const slots = new Map([slot("a"), slot("b"), slot("c", "catch_up")]);
    expect(runOrder([ws("a"), ws("b"), ws("c")], slots, [])[0].id).toBe("c");
  });

  it("least recently rewritten first, none in the week first, idle sites last", () => {
    const runs = [run("2026-10-05T07:31:00Z", "a"), run("2026-10-05T07:30:00Z", "b")];
    const slots = new Map<string, RewriteSlot>([slot("a"), slot("b"), slot("c"), ["d", { kind: "none", reason: "nothing scheduled" }]]);
    const order = runOrder([ws("d"), ws("a"), ws("b"), ws("c", { refresh_days: [1, 4] })], slots, runs).map((w) => w.id);
    expect(order).toEqual(["c", "b", "a", "d"]);
  });

  it("then the oldest due task", () => {
    const slots = new Map([slot("a", "scheduled", "2026-10-12"), slot("b", "scheduled", "2026-09-28")]);
    expect(runOrder([ws("a"), ws("b")], slots, []).map((w) => w.id)).toEqual(["b", "a"]);
  });
});
