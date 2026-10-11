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
