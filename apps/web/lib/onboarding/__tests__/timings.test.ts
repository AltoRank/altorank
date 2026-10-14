import { describe, expect, it } from "vitest";
import { mergeTimings, RunClock, summarise, timed, timingSummary, withRunClock, markTime, currentRunClock } from "../timings";

describe("RunClock", () => {
  it("records stages on the run's axis, merging overlapping calls into busy time", async () => {
    let now = 1_000;
    const clock = new RunClock(0, () => now);
    await clock.time("judge", async () => { now = 4_000; });
    clock.record("judge", 2_000, 6_000);
    clock.record("judge", 10_000, 11_000);
    const s = summarise(clock.entries).judge;
    expect(s).toEqual({ startMs: 1_000, endMs: 11_000, busyMs: 6_000, calls: 3 });
  });

  it("records a call that threw as failed, and rethrows", async () => {
    const clock = new RunClock(0, () => 5);
    await expect(clock.time("crawl", () => { throw new Error("no"); })).rejects.toThrow("no");
    expect(summarise(clock.entries).crawl.failed).toBe(1);
  });

  it("keeps a mark at its first value", () => {
    let now = 100;
    const clock = new RunClock(0, () => now);
    clock.mark("gate");
    now = 900;
    clock.mark("gate");
    expect(clock.marks.gate).toBe(100);
  });

  it("times through AsyncLocalStorage, and is a no-op outside a clock", async () => {
    expect(await timed("crawl", () => 7)).toBe(7);
    expect(currentRunClock()).toBeUndefined();
    const clock = new RunClock(Date.now());
    await withRunClock(clock, async () => {
      await Promise.all([timed("judge", async () => 1), timed("results_pages", async () => 2)]);
      markTime("gate");
    });
    expect(clock.entries.map((e) => e.stage).sort()).toEqual(["judge", "results_pages"]);
    expect(clock.marks.gate).toBeGreaterThanOrEqual(0);
  });
});

describe("mergeTimings", () => {
  it("puts two invocations on one timeline and keeps the earliest mark", () => {
    const a = new RunClock(0, () => 0);
    a.record("crawl", 0, 10_000);
    a.mark("run_done", 50_000);
    const b = new RunClock(0, () => 0);
    b.record("draft", 60_000, 120_000);
    b.mark("run_done", 120_000);
    const merged = mergeTimings(a.toJSON(), b.toJSON());
    expect(Object.keys(merged.stages).sort()).toEqual(["crawl", "draft"]);
    expect(merged.marks.run_done).toBe(50_000);
    expect(mergeTimings(null, b.toJSON()).stages.draft.busyMs).toBe(60_000);
  });

  it("writes only what a clock has not saved before", () => {
    const clock = new RunClock(0, () => 0);
    clock.record("crawl", 0, 1);
    clock.saved = 1;
    clock.record("draft", 2, 3);
    expect(clock.unsaved().entries.map((e) => e.stage)).toEqual(["draft"]);
  });
});

describe("timingSummary", () => {
  it("is seconds to one decimal, compact for an event's capped context", () => {
    const clock = new RunClock(0, () => 0);
    clock.record("crawl", 1_234, 15_678);
    clock.mark("gate", 61_049);
    expect(timingSummary(clock.toJSON())).toEqual({ stages: { crawl: [1.2, 15.7, 14.4, 1] }, marks: { gate: 61 } });
    expect(timingSummary(null)).toBeNull();
  });
});
