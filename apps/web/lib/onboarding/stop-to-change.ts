// ---------------------------------------------------------------------------
// Stop a first look to change what it was started on
// ---------------------------------------------------------------------------
//
// Since auto-start (components/onboarding/wizard.tsx, `autoStart`) the run
// begins as soon as the site read lands, and what the read found is shown
// beside it (components/onboarding/what-we-understood.tsx). An owner who saw
// the wrong business, market or language there had no way to say so before
// the free article was written on it: the panel pointed at Settings, and
// Settings is behind the trial (lib/billing/gate-paths.ts, OPEN_BEFORE_TRIAL).
//
// Editing the profile under the live run would not reach the run. The worker
// reads the language, the market and the profile once, when it starts
// (run-worker.ts), and the keyword research and the planner work from that
// read. So the fix is a restart: stop this run, open "Change what we found",
// and let its button start the next one.
//
// It is offered only while that costs the account nothing it cannot get back:
//
//   the run is still reading the site or      the keyword research has not
//   finding searches: keywords not settled,   stored its searches, so the next
//   planning and drafting not begun           run does not plan from this
//                                             one's, and no draft is claimed
//   the spend gate would start another        PRE_TRIAL_SETUP_RUNS counts this
//   setup now (canSpend, action "setup",      run, so it is a run left, not
//   asked while this run exists)              the one being stopped
//
// The run is closed as `error` with STOPPED_TO_CHANGE, not with a status of
// its own: the closed set is a database constraint (migration 104), and every
// reader already treats an `error` run that wrote nothing as a setup that may
// run again, which is what this one is. It is never announced: nothing failed,
// and the setup-failed email would tell the person to try again while they
// are doing exactly that.

import type { OnboardingPhase, OnboardingState, PhaseStatus } from "./events";

/** Stored on the run it closes; also what a reload of that run shows. */
export const STOPPED_TO_CHANGE = "Setup was stopped to change what we found.";

/** Said when the run moved past the point where stopping costs nothing. */
export const TOO_LATE_TO_STOP = "Setup has started planning on what we found, so it can no longer be stopped.";

type Step = { phase: OnboardingPhase | string; status: PhaseStatus | string };

/**
 * Whether a run with these steps may still be stopped and started over: the
 * keyword research has not settled, and neither planning nor drafting has
 * begun. Pure; read by the screen (to show the link) and by the stop itself
 * (to refuse a click that arrived too late).
 */
export function stoppableToChange(steps: readonly Step[] | null | undefined): boolean {
  const status = (phase: OnboardingPhase) => steps?.find((s) => s.phase === phase)?.status ?? "pending";
  const keywords = status("keywords");
  if (keywords !== "pending" && keywords !== "active") return false;
  return status("planning") === "pending" && status("drafting") === "pending";
}

/**
 * Whether the run screen shows "Wrong? Fix it and start over".
 *
 * `restartable` is the server's answer for the run on screen (null until it
 * has answered): the spend gate would start one more setup run. `firstAttempted`
 * is the page's: the one pre-trial article has been claimed, which no run
 * gives back.
 */
export function offerStopToChange(
  state: Pick<OnboardingState, "steps" | "article" | "drafts" | "ready" | "error"> | null,
  fact: { restartable: boolean | null; firstAttempted: boolean },
): boolean {
  if (!state || fact.restartable !== true || fact.firstAttempted) return false;
  if (state.ready || state.error !== null || state.article !== null || state.drafts.length > 0) return false;
  return stoppableToChange(state.steps);
}
