import { describe, expect, it, vi } from "vitest";
import { SEEN_RATIO, observeSeenOnce } from "../seen-once";

// offer_seen waits for the price box to be on screen, once. No DOM in this
// repo's tests, so the observer is a stand-in that the test drives.

class FakeObserver {
  static last: FakeObserver | null = null;
  observed: unknown[] = [];
  disconnected = false;
  constructor(
    public callback: IntersectionObserverCallback,
    public options?: IntersectionObserverInit,
  ) {
    FakeObserver.last = this;
  }
  observe(el: unknown) {
    this.observed.push(el);
  }
  disconnect() {
    this.disconnected = true;
  }
  fire(isIntersecting: boolean, intersectionRatio: number) {
    this.callback([{ isIntersecting, intersectionRatio } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

const el = {} as Element;

describe("observeSeenOnce", () => {
  it("says seen once half the box is on screen, then stops watching", () => {
    const onSeen = vi.fn();
    observeSeenOnce(el, onSeen, FakeObserver);
    const io = FakeObserver.last!;
    expect(io.observed).toEqual([el]);
    expect(io.options).toEqual({ threshold: SEEN_RATIO });
    io.fire(false, 0);
    io.fire(true, 0.2);
    expect(onSeen).not.toHaveBeenCalled();
    io.fire(true, 0.6);
    io.fire(true, 1);
    expect(onSeen).toHaveBeenCalledTimes(1);
    expect(io.disconnected).toBe(true);
  });

  it("returns a stop that disconnects before anything is seen", () => {
    const onSeen = vi.fn();
    const stop = observeSeenOnce(el, onSeen, FakeObserver);
    stop();
    expect(FakeObserver.last!.disconnected).toBe(true);
  });

  it("says nothing without an element or an observer: rendered is not seen", () => {
    const onSeen = vi.fn();
    expect(() => observeSeenOnce(null, onSeen, FakeObserver)()).not.toThrow();
    expect(() => observeSeenOnce(el, onSeen, undefined)()).not.toThrow();
    expect(onSeen).not.toHaveBeenCalled();
  });
});
