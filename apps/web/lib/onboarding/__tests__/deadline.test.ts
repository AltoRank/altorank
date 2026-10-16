import { describe, expect, it } from "vitest";
import { callSignal, currentDeadline, Deadline, isOutOfTime, OutOfTimeError, outOfTime, until, withDeadline, within } from "../deadline";
import { DRAFT_FINISH_MS, DRAFT_INVOCATION_MS, DRAFT_RECORD_MS, DRAFT_SAVE_MS, DRAFT_WRITER_MIN_MS } from "../time-limits";
import { readFileSync } from "node:fs";
import path from "node:path";

// The draft's deadline, carried by the work (lib/onboarding/deadline.ts), and
// the limits it is shared out by (lib/onboarding/time-limits.ts).

const never = <T,>() => new Promise<T>(() => undefined);
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a wait with a deadline", () => {
  it("ends when the signal aborts, whether or not the work notices, and swallows the work's late failure", async () => {
    let late: (err: Error) => void = () => undefined;
    const work = new Promise<string>((_, reject) => { late = reject; });
    const started = Date.now();
    const waited = until(work, AbortSignal.timeout(30), "the outline");
    await expect(waited).rejects.toBeInstanceOf(OutOfTimeError);
    await expect(waited).rejects.toMatchObject({ stage: "the outline" });
    expect(Date.now() - started).toBeLessThan(500);
    // Failing after the wait gave up is not an unhandled rejection.
    late(new Error("late"));
    await tick(5);
  });

  it("passes the work's own answer and its own failure through", async () => {
    await expect(until(Promise.resolve(3), AbortSignal.timeout(1_000), "x")).resolves.toBe(3);
    await expect(until(Promise.reject(new Error("boom")), AbortSignal.timeout(1_000), "x")).rejects.toThrow("boom");
    await expect(until(Promise.resolve(3), AbortSignal.abort(), "x")).rejects.toBeInstanceOf(OutOfTimeError);
  });

  it("bounds every call made inside the work, and nests without loosening", async () => {
    expect(currentDeadline()).toBeNull();
    const outer = new AbortController();
    await withDeadline(outer.signal, async () => {
      // A call's own bound and the work's: whichever ends first.
      const call = callSignal(60_000);
      expect(call.aborted).toBe(false);
      const inner = new AbortController();
      await withDeadline(inner.signal, async () => {
        const nested = callSignal(60_000);
        outer.abort();
        expect(nested.aborted).toBe(true);
        expect(outOfTime()).toBe(true);
      });
      expect(call.aborted).toBe(true);
    });
    expect(outOfTime()).toBe(false);
  });

  it("aborts what the work started and stops waiting at the same moment (within)", async () => {
    let seen: AbortSignal | null = null;
    const ran = within(AbortSignal.timeout(20), "images", async () => {
      seen = callSignal(60_000);
      return never<string>();
    });
    await expect(ran).rejects.toBeInstanceOf(OutOfTimeError);
    expect(seen!.aborted).toBe(true);
  });

  it("says which errors are out of time", () => {
    expect(isOutOfTime(new OutOfTimeError("x"))).toBe(true);
    expect(isOutOfTime(Object.assign(new Error("x"), { name: "GenerationTimedOutError" }))).toBe(true);
    expect(isOutOfTime(new Error("x"))).toBe(false);
  });
});

describe("a deadline shared out by step", () => {
  it("gives a step at most its cap and never the reserve kept after it", async () => {
    let now = 1_000;
    const d = new Deadline(11_000, () => now);
    expect(d.left()).toBe(10_000);
    expect(d.left(4_000)).toBe(6_000);
    now = 20_000;
    expect(d.left(4_000)).toBe(0);
    const spent = d.signal(5_000, 1_000);
    now = 1_000;
    const capped = d.signal(20, 1_000);
    await tick(40);
    expect(spent.aborted).toBe(true);
    expect(capped.aborted).toBe(true);
  });
});

describe("the draft's limits", () => {
  it("leave the writer time, the checks time after it, and the route time to record the end", () => {
    const deadline = DRAFT_INVOCATION_MS - DRAFT_RECORD_MS;
    const writerStops = deadline - DRAFT_FINISH_MS;
    const writerStartsBy = writerStops - DRAFT_WRITER_MIN_MS;
    expect(DRAFT_RECORD_MS).toBeGreaterThanOrEqual(15_000);
    expect(DRAFT_FINISH_MS).toBeGreaterThan(DRAFT_SAVE_MS);
    // A whole draft measured at 209s (lib/content/generate-queue.ts) fits.
    expect(writerStops).toBeGreaterThan(209_000);
    expect(writerStartsBy).toBeGreaterThan(120_000);
  });

  it("are measured against the draft route's maxDuration", () => {
    const route = readFileSync(path.resolve(__dirname, "../../../app/api/internal/draft/route.ts"), "utf8");
    const declared = Number(route.match(/export const maxDuration = (\d+);/)?.[1]);
    expect(declared * 1000).toBe(DRAFT_INVOCATION_MS);
    const cron = readFileSync(path.resolve(__dirname, "../../../app/api/cron/generate/route.ts"), "utf8");
    expect(Number(cron.match(/export const maxDuration = (\d+);/)?.[1]) * 1000).toBe(DRAFT_INVOCATION_MS);
  });
});
