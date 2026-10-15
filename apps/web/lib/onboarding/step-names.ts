// ---------------------------------------------------------------------------
// The steps of a signup, as onboarding.step events name them
// ---------------------------------------------------------------------------
//
// Client-safe: the names and nothing else. The write is server-side
// (./step-events.ts, /api/onboard/step); the browser only says which step it
// reached (./track-step.ts).

export const STEP_EVENT_SOURCE = "onboarding.step";

/** In the order a signup meets them. */
export const ONBOARDING_STEPS = [
  "wizard_opened",
  "site_read_started",
  "site_read_finished",
  "site_read_failed",
  "profile_shown",
  "competitor_step_done",
  "plan_clicked",
  // The run started by itself once the site read landed (wizard autoStart),
  // with no click: kept apart from plan_clicked so the funnel says which.
  "plan_auto",
  "run_started",
  "gate_shown",
  "trial_clicked",
  "checkout_returned",
  "checkout_cancelled",
] as const;
export type OnboardingStepName = (typeof ONBOARDING_STEPS)[number];

export function isOnboardingStep(value: unknown): value is OnboardingStepName {
  return typeof value === "string" && (ONBOARDING_STEPS as readonly string[]).includes(value);
}

/**
 * Written by the server alone (/api/onboard/start), never accepted from the
 * browser: each step is kept once per workspace, so a client that said it
 * first would take the slot and the funnel's run-start time with it.
 */
export const SERVER_ONLY_STEPS: readonly OnboardingStepName[] = ["run_started"];

/** A step the browser may report (/api/onboard/step). */
export function isClientStep(value: unknown): value is OnboardingStepName {
  return isOnboardingStep(value) && !SERVER_ONLY_STEPS.includes(value);
}
