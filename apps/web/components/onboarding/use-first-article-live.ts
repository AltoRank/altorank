"use client";

// ---------------------------------------------------------------------------
// The first article while its body is written behind the gate
// ---------------------------------------------------------------------------
//
// One poller for the gate, whichever way PRETRIAL_FULL_ARTICLE is set:
//
// - on, for the owner: /api/onboard/first-article every second - the text so
//   far, and the counts beside it;
// - off: /api/onboard/first-article/progress every two seconds - which of
//   the outline's sections are written and the words so far, never text.
//
// It stops once the body is saved, and says so (`done`), so the heading, the
// card and the reader flip together instead of 19 seconds apart (recorded
// 2026-10-12). A 404 is a refusal - not the owner, not the run's first
// article - and stops it quietly: the card then stays as the page drew it.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { BodyStage } from "@/lib/onboarding/setup-progress";
import { visibleLength } from "@/lib/onboarding/stream-reveal";

/** Text mode: about how often the server flushes it, so typing never starves. */
export const TEXT_POLL_MS = 1_000;
/** Counts mode: the outline ticks a section at a time; every two seconds is plenty. */
export const COUNTS_POLL_MS = 2_000;
/** Stop asking after this long without a finished body; the gate still stands. */
const GIVE_UP_MS = 10 * 60_000;

export interface FirstArticleLive {
  /** The text so far (text mode only), as the server cleaned it. */
  html: string;
  done: boolean;
  stage: BodyStage | null;
  /** When `stage` began, on this browser's clock; null until known. */
  stageSince: number | null;
  sectionsDone: number[];
  words: number;
  /** Characters a second the text has been arriving at lately (text mode). */
  arrivalCps: number;
  /** The server refused: nothing here is this person's to watch. */
  refused: boolean;
}

const EMPTY: FirstArticleLive = { html: "", done: false, stage: null, stageSince: null, sectionsDone: [], words: 0, arrivalCps: 0, refused: false };

type Answer = {
  html?: string;
  done?: boolean;
  stage?: BodyStage | null;
  stageMs?: number;
  sectionsDone?: number[];
  words?: number;
  progress?: Answer;
};

export function useFirstArticleLive({
  workspaceId,
  mode,
  enabled,
  initial,
  onDone,
}: {
  workspaceId: string;
  /** "text": the owner reads it as it is written; "counts": the outline ticks. */
  mode: "text" | "counts";
  /** False once the page already knows the body is written: nothing to watch. */
  enabled: boolean;
  initial?: Partial<FirstArticleLive>;
  /** Once, when the body is saved. */
  onDone?: () => void;
}): FirstArticleLive {
  const [live, setLive] = useState<FirstArticleLive>(() => ({ ...EMPTY, ...initial }));
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    // The arrival pace: characters over time between answers, smoothed.
    let lastLength = -1;
    let lastAt = 0;
    let cps = 0;
    const url = mode === "text"
      ? `/api/onboard/first-article?workspaceId=${encodeURIComponent(workspaceId)}`
      : `/api/onboard/first-article/progress?workspaceId=${encodeURIComponent(workspaceId)}`;

    async function poll() {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (stopped) return;
        if (res.status === 404 || res.status === 401) {
          setLive((l) => ({ ...l, refused: true }));
          return;
        }
        if (res.ok) {
          const body = (await res.json()) as Answer;
          if (stopped) return;
          const counts = body.progress ?? body;
          const now = Date.now();
          const html = typeof body.html === "string" ? body.html : "";
          const length = mode === "text" ? visibleLength(html) : 0;
          if (mode === "text" && lastLength >= 0 && now > lastAt && length >= lastLength) {
            const rate = ((length - lastLength) * 1000) / (now - lastAt);
            cps = cps === 0 ? rate : cps * 0.6 + rate * 0.4;
          }
          lastLength = length;
          lastAt = now;
          const done = body.done === true;
          setLive((l) => ({
            html: mode === "text" ? html : l.html,
            done,
            stage: counts.stage ?? null,
            // Kept while the stage is unchanged, so the bar does not jump
            // back and forth with each answer's rounding.
            stageSince: counts.stage && counts.stage === l.stage && l.stageSince !== null ? l.stageSince : counts.stage ? now - Math.max(0, counts.stageMs ?? 0) : null,
            sectionsDone: Array.isArray(counts.sectionsDone) ? counts.sectionsDone.filter((n) => Number.isInteger(n)) : l.sectionsDone,
            words: typeof counts.words === "number" ? counts.words : l.words,
            arrivalCps: cps,
            refused: false,
          }));
          if (done) {
            onDoneRef.current?.();
            return;
          }
        }
      } catch {
        // A missed poll is the next one's.
      }
      if (!stopped && Date.now() - started < GIVE_UP_MS) timer = setTimeout(poll, mode === "text" ? TEXT_POLL_MS : COUNTS_POLL_MS);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [workspaceId, mode, enabled]);

  return live;
}

const REDUCED = "(prefers-reduced-motion: reduce)";

/** Whether this browser asked for less motion, kept current; false on the server. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = typeof window !== "undefined" ? window.matchMedia?.(REDUCED) : undefined;
      mq?.addEventListener?.("change", onChange);
      return () => mq?.removeEventListener?.("change", onChange);
    },
    () => Boolean(window.matchMedia?.(REDUCED).matches),
    () => false,
  );
}
