// ---------------------------------------------------------------------------
// How far a first look has got, as a bar a person can watch
// ---------------------------------------------------------------------------
//
// The run screen had no sense of time: phases flipped from a spinner to a
// tick, and between flips nothing on the page moved - 19 seconds with no
// change after the first lines, 30 to 40 on "Scheduling your first month",
// and two minutes of a static gate while the body was written (recorded on
// 2026-10-12, site C, both switch positions).
//
// So the bar is driven by the clock, held to what the run has actually
// reported. Each phase has the time it usually ends at, measured on #272's
// fast first look (local, real providers): the bar walks with the elapsed
// time, never behind the phases already finished (`floor`) and never past
// the phases still running (`ceiling`). When a phase runs long the bar slows
// toward its ceiling instead of stopping or lying about being done.
//
// Pure: the screen feeds it the run's steps and the seconds since the run
// started; the tests feed it the same.

import { PHASE_ORDER, type OnboardingPhase, type OnboardingStep } from "./events";

/**
 * When each phase usually ends, in seconds from the run's start. Measured on
 * the fast first look (2026-10-12): the site read 33-43s, the keyword work
 * 44s, the existing pages 28s alongside, planning 77-86s, the outline - the
 * gate - 84-100s. Rounded to what the median run does.
 */
export const EXPECTED_END_S: Record<OnboardingPhase, number> = {
  scanning: 40,
  keywords: 45,
  pages: 30,
  planning: 80,
  drafting: 92,
};

/** The gate: the end of the slowest phase. */
export const EXPECTED_GATE_S = Math.max(...Object.values(EXPECTED_END_S));

/**
 * After the gate, the body: the writer thinks before its first word (about
 * 45s, no text at all), writes (about 40s for 1,500 words), and the result is
 * checked, linked and saved (about 20s). Measured on the same two runs.
 */
export const BODY_STAGE_S = { thinking: 45, writing: 40, finishing: 20 } as const;
export type BodyStage = keyof typeof BODY_STAGE_S;
export const BODY_ORDER: readonly BodyStage[] = ["thinking", "writing", "finishing"];

/** How close to a ceiling the bar may walk at the clock's pace before it starts to slow. */
const SLACK_S = 8;
/** The bar never shows a run as finished before it is. */
const MAX_UNFINISHED = 0.97;

const settled = (s: OnboardingStep) => s.status === "done" || s.status === "skipped" || s.status === "failed";

/**
 * Where the clock may put the bar, between `floor` and `ceiling` seconds: at
 * the elapsed time while there is room, then easing toward the ceiling,
 * never reaching it. Pure, monotonic in `elapsed`.
 */
export function easeInto(elapsed: number, floor: number, ceiling: number): number {
  const top = Math.max(ceiling, floor);
  const t = Math.max(elapsed, floor);
  const knee = Math.max(floor, top - SLACK_S);
  if (t <= knee) return t;
  const room = top - knee;
  return knee + room * (1 - Math.exp(-(t - knee) / Math.max(room, 1)));
}

/**
 * The run's progress, 0 to 1. 1 only when every phase has settled; below
 * that it is held between the phases finished and the ones still running.
 */
export function setupFraction(steps: readonly OnboardingStep[], elapsedS: number): number {
  if (steps.length && steps.every(settled)) return 1;
  let floor = 0;
  let ceiling = 0;
  for (const step of steps) {
    const end = EXPECTED_END_S[step.phase];
    if (settled(step)) floor = Math.max(floor, end);
    else if (step.status === "active") ceiling = Math.max(ceiling, end);
  }
  // Nothing active yet (the first poll): the bar may walk toward the first
  // phase still to come.
  if (ceiling === 0) {
    const next = PHASE_ORDER.find((p) => steps.find((s) => s.phase === p)?.status === "pending");
    ceiling = next ? EXPECTED_END_S[next] : floor;
  }
  const at = easeInto(Math.max(0, elapsedS), floor, Math.max(ceiling, floor));
  return Math.min(MAX_UNFINISHED, at / EXPECTED_GATE_S);
}

/**
 * The phase the screen leads with: the earliest one still running, in run
 * order, or the next to start. Null once everything has settled.
 */
export function leadingPhase(steps: readonly OnboardingStep[]): OnboardingPhase | null {
  for (const phase of PHASE_ORDER) {
    // The existing pages are read alongside the keyword work; they never lead.
    if (phase === "pages") continue;
    const step = steps.find((s) => s.phase === phase);
    if (step && !settled(step)) return phase;
  }
  return null;
}

/** "Reading your site", for the heading: what is happening now, in the person's words. */
export function leadingHeadline(phase: OnboardingPhase | null, domain: string): string {
  switch (phase) {
    case "scanning":
      return domain ? `Reading ${domain}` : "Reading your site";
    case "keywords":
      return "Finding what your buyers search for";
    case "pages":
      return "Checking your existing pages";
    case "planning":
      return "Checking which topics you can win";
    case "drafting":
      return "Outlining your first article";
    default:
      return "Setting up your first article";
  }
}

/**
 * The body's progress after the gate, 0 to 1: the stage it is in, walked by
 * the seconds it has been in that stage, eased the same way. 1 when done.
 */
export function bodyFraction(stage: BodyStage | null, stageElapsedS: number, done: boolean): number {
  if (done) return 1;
  const total = BODY_ORDER.reduce((sum, s) => sum + BODY_STAGE_S[s], 0);
  const current = stage ?? "thinking";
  const before = BODY_ORDER.slice(0, BODY_ORDER.indexOf(current)).reduce((sum, s) => sum + BODY_STAGE_S[s], 0);
  const at = easeInto(before + Math.max(0, stageElapsedS), before, before + BODY_STAGE_S[current]);
  return Math.min(MAX_UNFINISHED, at / total);
}

// ---------------------------------------------------------------------------
// One bar and one clock, from the click to the written article
// ---------------------------------------------------------------------------
//
// There were two: the loading screen's reached about 85% at 1:24 against
// "usually about 1:32", and then the gate drew a second one near 2% with "usually
// about 2 minutes" (UX audit 2026-10-12, #7). Now the setup is the first part of
// one bar and the body the rest, the clock runs from the click to the written
// article, and there is one promise: about FIRST_LOOK_MINUTES minutes, the
// number the wizard's bar quotes (lib/onboarding/copy.ts).

/**
 * The one estimate the screens quote. Recorded 2026-10-12 on two runs: gate
 * at 93s and body written at 168s, and gate at 97s and body written at 209s.
 * "About 3 minutes" covers both.
 */
export const FIRST_LOOK_MINUTES = 3;

/** The body, start to saved, as the stages above add up. */
export const EXPECTED_BODY_S = BODY_ORDER.reduce((sum, s) => sum + BODY_STAGE_S[s], 0);

/** How much of the one bar the setup takes; the body is the rest. */
export const SETUP_SHARE = EXPECTED_GATE_S / (EXPECTED_GATE_S + EXPECTED_BODY_S);

/**
 * Past this, the screens say it is taking longer than usual. Set from the
 * slower recorded run (209s) plus a minute, not from the promise plus half a
 * minute: at 3:30 a normal run (3:29) all but tripped it, and the card told
 * the owner they could leave while the article was finishing on screen
 * (review, 2026-10-12).
 */
export const LONGER_AFTER_S = 270;

/**
 * The whole first look, 0 to 1. Before the gate, the setup's own progress
 * scaled into its share; after it, the body's, scaled into the rest. The
 * swap is continuous: the setup's share ends where the body's begins.
 */
export function firstLookFraction(
  steps: readonly OnboardingStep[],
  elapsedS: number,
  body: { stage: BodyStage | null; stageElapsedS: number; done: boolean } | null = null,
): number {
  if (body) {
    if (body.done) return 1;
    return Math.min(MAX_UNFINISHED, SETUP_SHARE + (1 - SETUP_SHARE) * bodyFraction(body.stage, body.stageElapsedS, false));
  }
  // The setup at its end is the gate, not the article: it fills its share.
  return Math.min(SETUP_SHARE, setupFraction(steps, elapsedS) * SETUP_SHARE);
}

/**
 * Whether to say "taking longer than usual": past LONGER_AFTER_S on the one
 * clock, or - before the gate - when the setup alone has run a minute past
 * its usual end, since the article cannot then land in about three minutes.
 */
export function runningLong(elapsedS: number, gateReached: boolean): boolean {
  if (elapsedS > LONGER_AFTER_S) return true;
  return !gateReached && elapsedS > EXPECTED_GATE_S + 60;
}

/** The clock's second line: the one estimate, or that it is running long. */
export function estimateLine(elapsedS: number, gateReached: boolean): string {
  return runningLong(elapsedS, gateReached) ? "Taking longer than usual" : `about ${FIRST_LOOK_MINUTES} minutes in all`;
}

/** "0:47". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
