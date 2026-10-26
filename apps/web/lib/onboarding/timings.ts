// ---------------------------------------------------------------------------
// How long each stage of a first look took, measured where it runs
// ---------------------------------------------------------------------------
//
// A production first look (2026-10-09, site C) took 7m15s from run start to
// done, and the only record of where the time went was provider_spend's
// timestamps: nothing billed for the first 96 seconds, so the site read, the
// crawl, the speed test and the voice were one undivided silence. This is the
// stopwatch: every stage of the run, start and end in milliseconds since the
// run began, wherever in the call tree it happens.
//
// It travels like the spend scope does (lib/billing/spend-scope.ts), in
// AsyncLocalStorage, so a stage deep in the keyword research is timed without
// a parameter threaded through every function between it and the worker.
// Outside a clock - the crons, the editor, a test - `timed` just runs the
// function.
//
// Stages may overlap (a batch of judge reads runs side by side), so the
// summary keeps three numbers per stage: when it first started and last
// ended (`startMs`, `endMs`), the wall time it occupied with overlaps merged
// (`busyMs`), and how many times it ran (`calls`). The raw entries are kept,
// bounded, so a summary written by one invocation can be merged with the
// next one's (the draft route's) and recomputed.
//
// Instrumentation, so it never throws and never decides anything.

import { AsyncLocalStorage } from "node:async_hooks";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The stages a first look is timed in. Free text is accepted by the clock
 * (a stage a later change adds still lands); these are the ones the code
 * names today, in run order.
 */
export const TIMED_STAGES = [
  "reach",
  "site_read",
  // A locked Shopify storefront's pages, read through the Admin API (lib/shopify/store-content.ts).
  "store_content",
  // Its business profile, inferred from the store's catalogue when the install skipped the wizard.
  "store_profile",
  "voice",
  "analysis",
  "readiness",
  "crawl",
  "topical_profile",
  "pagespeed",
  "platform",
  "ranked",
  "authority",
  "discovery",
  "buyer_fit",
  "keyword_store",
  "backlinks",
  "gsc_seed",
  "pages",
  "link_pool",
  "plan",
  // A first look's ranking (./first-look-plan.ts): the rivals' sitemaps, the one suggestion call, the volumes for what it added.
  "rival_pages",
  "suggest",
  "suggest_metrics",
  "results_pages",
  "judge",
  "first_topic",
  "related_keywords",
  "outline",
  "draft_research",
  "draft",
  "enrich",
  "images",
  "fact_check",
  "save",
] as const;
export type TimedStage = (typeof TIMED_STAGES)[number];

/** One timed interval, in milliseconds since the run started. */
export interface TimingEntry {
  stage: string;
  start: number;
  end: number;
  ok: boolean;
}

export interface StageSummary {
  /** When the stage first started, ms since the run began. */
  startMs: number;
  /** When it last ended. */
  endMs: number;
  /** Wall time it occupied, overlapping calls merged. */
  busyMs: number;
  calls: number;
  /** Calls that threw. */
  failed?: number;
}

/** What the run row and the funnel event carry. */
export interface RunTimings {
  /** ISO time the run started: every number is relative to it. */
  origin: string;
  stages: Record<string, StageSummary>;
  /** Named moments, ms since the run began: `gate`, `body_done`, `run_done`. */
  marks: Record<string, number>;
  /** Raw intervals, oldest first, capped at MAX_ENTRIES. */
  entries: TimingEntry[];
}

/** Bounds the jsonb: a first look makes a few hundred timed calls at most. */
export const MAX_ENTRIES = 600;

export class RunClock {
  readonly origin: number;
  readonly entries: TimingEntry[] = [];
  readonly marks: Record<string, number> = {};
  /** Entries already written to the row, so a second save adds only the rest. */
  saved = 0;

  /** `origin` is the run's start (onboarding_runs.started_at), so two invocations share one axis. */
  constructor(origin: number | string | Date = Date.now(), private readonly now: () => number = Date.now) {
    const ms = typeof origin === "number" ? origin : new Date(origin).getTime();
    this.origin = Number.isFinite(ms) ? ms : now();
  }

  /** Milliseconds since the run began. */
  elapsed(at: number = this.now()): number {
    return Math.max(0, Math.round(at - this.origin));
  }

  record(stage: string, startedAt: number, endedAt: number, ok = true): void {
    if (this.entries.length >= MAX_ENTRIES) return;
    this.entries.push({ stage, start: this.elapsed(startedAt), end: this.elapsed(endedAt), ok });
  }

  /** Time `fn` as `stage`. Rethrows what it throws, recorded as a failed call. */
  async time<T>(stage: string, fn: () => Promise<T> | T): Promise<T> {
    const started = this.now();
    try {
      const value = await fn();
      this.record(stage, started, this.now(), true);
      return value;
    } catch (err) {
      this.record(stage, started, this.now(), false);
      throw err;
    }
  }

  /** A named moment, kept at its first value: the gate is shown once. */
  mark(name: string, at: number = this.now()): void {
    if (this.marks[name] === undefined) this.marks[name] = this.elapsed(at);
  }

  toJSON(): RunTimings {
    return { origin: new Date(this.origin).toISOString(), stages: summarise(this.entries), marks: { ...this.marks }, entries: [...this.entries] };
  }

  /** What has not been written to the row yet: the entries since the last save, and every mark. */
  unsaved(): RunTimings {
    const entries = this.entries.slice(this.saved);
    return { origin: new Date(this.origin).toISOString(), stages: summarise(entries), marks: { ...this.marks }, entries };
  }
}

/** Per-stage summary of a list of intervals. Pure. */
export function summarise(entries: readonly TimingEntry[]): Record<string, StageSummary> {
  const byStage = new Map<string, TimingEntry[]>();
  for (const e of entries) {
    const list = byStage.get(e.stage) ?? [];
    list.push(e);
    byStage.set(e.stage, list);
  }
  const out: Record<string, StageSummary> = {};
  for (const [stage, list] of byStage) {
    const sorted = [...list].sort((a, b) => a.start - b.start);
    let busy = 0;
    let curStart = sorted[0].start;
    let curEnd = sorted[0].end;
    for (const e of sorted.slice(1)) {
      if (e.start <= curEnd) curEnd = Math.max(curEnd, e.end);
      else {
        busy += curEnd - curStart;
        curStart = e.start;
        curEnd = e.end;
      }
    }
    busy += curEnd - curStart;
    const failed = list.filter((e) => !e.ok).length;
    out[stage] = {
      startMs: sorted[0].start,
      endMs: Math.max(...list.map((e) => e.end)),
      busyMs: busy,
      calls: list.length,
      ...(failed ? { failed } : {}),
    };
  }
  return out;
}

/**
 * Two invocations' timings as one: the worker's and the draft route's share
 * the run's start as their origin. Entries are concatenated (bounded),
 * marks keep their earliest value.
 */
export function mergeTimings(a: RunTimings | null | undefined, b: RunTimings): RunTimings {
  if (!a || !Array.isArray(a.entries)) return { ...b, stages: summarise(b.entries) };
  const entries = [...a.entries, ...b.entries].slice(0, MAX_ENTRIES);
  const marks: Record<string, number> = { ...(a.marks ?? {}) };
  for (const [k, v] of Object.entries(b.marks ?? {})) if (marks[k] === undefined || v < marks[k]) marks[k] = v;
  return { origin: a.origin ?? b.origin, stages: summarise(entries), marks, entries };
}

/**
 * The summary as an event's context carries it: seconds, one decimal, each
 * stage as `[start, end, busy, calls]`, the marks as seconds. Compact on
 * purpose - an event's whole context is capped at 4,000 characters
 * (lib/observability/event.ts) and the funnel event has other things to say.
 */
export function timingSummary(t: RunTimings | null | undefined): { stages: Record<string, [number, number, number, number]>; marks: Record<string, number> } | null {
  if (!t) return null;
  const sec = (ms: number) => Math.round(ms / 100) / 10;
  const stages: Record<string, [number, number, number, number]> = {};
  for (const [stage, v] of Object.entries(t.stages ?? {})) stages[stage] = [sec(v.startMs), sec(v.endMs), sec(v.busyMs), v.calls];
  const marks: Record<string, number> = {};
  for (const [k, v] of Object.entries(t.marks ?? {})) marks[k] = sec(v);
  return { stages, marks };
}

const store = new AsyncLocalStorage<RunClock>();

/** Run `fn` with `clock` as the stopwatch every `timed` call inside it reports to. */
export function withRunClock<T>(clock: RunClock, fn: () => T): T {
  return store.run(clock, fn);
}

export function currentRunClock(): RunClock | undefined {
  return store.getStore();
}

/** Time `fn` as `stage` on the current run's clock; without one, just run it. */
export async function timed<T>(stage: TimedStage, fn: () => Promise<T> | T): Promise<T> {
  const clock = store.getStore();
  if (!clock) return fn();
  return clock.time(stage, fn);
}

/** A named moment on the current run's clock. */
export function markTime(name: string): void {
  store.getStore()?.mark(name);
}

/**
 * Write the clock's timings to the run row (migration 107), merged with
 * whatever an earlier invocation wrote. Its own update, never part of the
 * phases write: on a database without the column only this fails, and it
 * fails quietly. Resolves whatever happens.
 */
export async function saveRunTimings(db: SupabaseClient, runId: string, clock: RunClock): Promise<RunTimings | null> {
  try {
    const { data, error: readError } = await db.from("onboarding_runs").select("timings").eq("id", runId).maybeSingle();
    if (readError) {
      console.warn(`[timings] run ${runId}: could not read timings (${readError.message})`);
      return null;
    }
    const pending = clock.unsaved();
    const merged = mergeTimings((data as { timings?: RunTimings | null } | null)?.timings ?? null, pending);
    const { error } = await db.from("onboarding_runs").update({ timings: merged }).eq("id", runId);
    if (error) {
      console.warn(`[timings] run ${runId}: could not write timings (${error.message})`);
      return null;
    }
    clock.saved += pending.entries.length;
    return merged;
  } catch (err) {
    console.warn(`[timings] run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** One line per stage, for a log or a proof run's table. */
export function timingTable(t: RunTimings): string {
  const rows = Object.entries(t.stages).sort((a, b) => a[1].startMs - b[1].startMs);
  const s = (ms: number) => (ms / 1000).toFixed(1).padStart(6);
  const lines = rows.map(([stage, v]) => `${stage.padEnd(18)} ${s(v.startMs)}s → ${s(v.endMs)}s  busy ${s(v.busyMs)}s  ×${v.calls}${v.failed ? ` (${v.failed} failed)` : ""}`);
  const marks = Object.entries(t.marks).sort((a, b) => a[1] - b[1]).map(([k, v]) => `${k.padEnd(18)} ${s(v)}s`);
  return [...lines, ...(marks.length ? ["--", ...marks] : [])].join("\n");
}
