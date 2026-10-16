// ---------------------------------------------------------------------------
// The time a piece of work has left, carried by the work
// ---------------------------------------------------------------------------
//
// A draft is written in one invocation the platform kills at its maxDuration
// (./time-limits.ts). Every paid call inside it already has a bound of its
// own - a structured call 250s, a DataForSEO request 90s - but bounds of their
// own do not add up to the draft's: research that waited on two of them in a
// row ran the draft past the platform's ceiling, where nothing records the
// failure.
//
// So the draft's deadline travels with the work, in AsyncLocalStorage, the
// way a spend scope does (lib/billing/spend-scope.ts): a call made inside
// `withDeadline` - or inside anything it awaits - is aborted when the work it
// is part of runs out of time, as well as at its own bound (`callSignal`).
// Outside one, a call keeps its own bound and nothing else changes.

import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<AbortSignal>();

/**
 * Run `fn` with `signal` bounding every call made inside it. Nested: an inner
 * deadline bounds its own work as well as the outer one, never instead.
 */
export function withDeadline<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  const outer = store.getStore();
  return store.run(outer && outer !== signal ? AbortSignal.any([outer, signal]) : signal, fn);
}

/** The signal of the work this call is part of, or null outside any. */
export function currentDeadline(): AbortSignal | null {
  return store.getStore() ?? null;
}

/** Whether the work this call is part of has already run out of time. */
export function outOfTime(): boolean {
  return store.getStore()?.aborted ?? false;
}

/**
 * The signal one call is sent with: aborted after `ms`, when the work it is
 * part of runs out of time, or when any of `also` aborts.
 */
export function callSignal(ms: number, ...also: Array<AbortSignal | null | undefined>): AbortSignal {
  const signals = [AbortSignal.timeout(ms), store.getStore(), ...also].filter((s): s is AbortSignal => Boolean(s));
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

/** A step that did not finish in the time it was given. */
export class OutOfTimeError extends Error {
  constructor(
    public readonly stage: string,
    message?: string,
  ) {
    super(message ?? `Out of time: ${stage} did not finish in the time the draft had left.`);
    this.name = "OutOfTimeError";
  }
}

/** Whether an error is a step, a call or a writer that ran out of time. */
export function isOutOfTime(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "OutOfTimeError" || name === "GenerationTimedOutError";
}

/**
 * Wait for `work` until `signal` aborts, then reject with OutOfTimeError.
 * What `work` does after that is not waited for (and its own rejection is
 * swallowed, so a late failure is not an unhandled one); work that took the
 * same signal is aborted with it.
 */
export function until<T>(work: Promise<T>, signal: AbortSignal, stage: string): Promise<T> {
  work.catch(() => undefined);
  if (signal.aborted) return Promise.reject(new OutOfTimeError(stage));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new OutOfTimeError(stage));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (err: unknown) => { signal.removeEventListener("abort", onAbort); reject(err); },
    );
  });
}

/**
 * `fn` with `signal` as its deadline (`withDeadline`), waited for until the
 * signal aborts (`until`): the calls inside are aborted and the wait ends at
 * the same moment, whether or not the work notices.
 */
export function within<T>(signal: AbortSignal, stage: string, fn: () => Promise<T>): Promise<T> {
  return until(withDeadline(signal, fn), signal, stage);
}

/**
 * A moment work must end by, and the share of it each step may take: a step
 * gets at most `cap`, and never runs into the `reserve` kept for the steps
 * after it.
 */
export class Deadline {
  constructor(
    public readonly at: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Milliseconds left before `reserve` is reached, never below zero. */
  left(reserve = 0): number {
    return Math.max(0, this.at - reserve - this.now());
  }

  /** Aborts after `cap`, or `reserve` before the deadline, whichever is first. */
  signal(cap = Number.POSITIVE_INFINITY, reserve = 0): AbortSignal {
    return AbortSignal.timeout(Math.max(0, Math.min(cap, this.left(reserve))));
  }
}
