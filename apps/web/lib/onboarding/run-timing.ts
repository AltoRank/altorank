// ---------------------------------------------------------------------------
// How long a first look takes, as measured
// ---------------------------------------------------------------------------
//
// The run screen's progress bar (./setup-progress) and every sentence that
// tells a person how long setup takes read these numbers, so the copy cannot
// drift from the measurement. Types only from ./events: it imports nothing at
// runtime, so events.ts can import it without a cycle.

import type { OnboardingPhase } from "./events";

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

/** The whole first look, gate plus the first article's body, in seconds. */
export const EXPECTED_RUN_S = EXPECTED_GATE_S + BODY_ORDER.reduce((sum, stage) => sum + BODY_STAGE_S[stage], 0);

/** "about 3 minutes": the measured run, rounded to whole minutes. */
export function expectedRunPhrase(): string {
  const minutes = Math.max(1, Math.round(EXPECTED_RUN_S / 60));
  return minutes === 1 ? "about a minute" : `about ${minutes} minutes`;
}
