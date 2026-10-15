import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDraftSaver } from "../draft-saver";

describe("saving the wizard as the owner edits", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("saves once, the newest value, when edits pause", async () => {
    const save = vi.fn(async () => undefined);
    const d = createDraftSaver<string>(save, 800);
    d.push("a");
    await vi.advanceTimersByTimeAsync(500);
    d.push("ab");
    await vi.advanceTimersByTimeAsync(500);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(save.mock.calls).toEqual([["ab"]]);
  });

  it("keeps saves in order: an edit during a slow save is saved after it", async () => {
    const order: string[] = [];
    let release!: () => void;
    const save = vi.fn((v: string) => {
      order.push(`start ${v}`);
      return v === "one" ? new Promise<void>((r) => (release = () => { order.push("end one"); r(); })) : Promise.resolve(order.push(`end ${v}`));
    });
    const d = createDraftSaver<string>(save, 100);
    d.push("one");
    await vi.advanceTimersByTimeAsync(100);
    d.push("two");
    await vi.advanceTimersByTimeAsync(100);
    expect(order).toEqual(["start one"]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["start one", "end one", "start two", "end two"]);
  });

  it("drops what is pending and waits for a save in flight before the final click", async () => {
    let release!: () => void;
    const save = vi.fn((v: string) => (v === "first" ? new Promise<void>((r) => (release = r)) : Promise.resolve()));
    const d = createDraftSaver<string>(save, 100);
    d.push("first");
    await vi.advanceTimersByTimeAsync(100);
    d.push("pending");
    let stopped = false;
    const stopping = d.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(500);
    expect(stopped).toBe(false);
    release();
    await stopping;
    await vi.advanceTimersByTimeAsync(500);
    expect(save.mock.calls).toEqual([["first"]]);
    // Stopped is stopped, until a failed final click resumes it.
    d.push("after");
    await vi.advanceTimersByTimeAsync(500);
    expect(save).toHaveBeenCalledTimes(1);
    d.resume();
    d.push("after");
    await vi.advanceTimersByTimeAsync(100);
    expect(save).toHaveBeenLastCalledWith("after");
  });

  it("saves at once on flush, and a failed save does not stop the next", async () => {
    const save = vi.fn(async (v: string) => {
      if (v === "bad") throw new Error("offline");
    });
    const d = createDraftSaver<string>(save, 10_000);
    d.push("bad");
    await d.flush();
    d.push("good");
    await d.flush();
    expect(save.mock.calls).toEqual([["bad"], ["good"]]);
  });
});
