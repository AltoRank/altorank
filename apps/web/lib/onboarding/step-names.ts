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
  // An account that reached the app with no site named one on
  // /onboarding/site (app/actions/first-site.ts). Signup's own site has no
  // step: its `signup` event already says when it was made.
  "site_added",
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
  // What came of the click in the browser, when it was not a trial: the
  // form was left (and how), or it never opened. Stripe has the rest.
  "checkout_closed",
  "checkout_failed",
  "checkout_returned",
  "checkout_cancelled",
  // After the run: what the gate showed and whether the offer was on screen,
  // then the trial (Stripe's word, not the browser's) and the article's way
  // out - opened, copied, approved. Props per step: ./step-props.ts.
  "setup_ending_shown",
  "offer_seen",
  "trial_started",
  "article_opened",
  "article_copied",
  "article_approved",
  // The dashboard's one primary action (components/dashboard/next-up.tsx):
  // the waiting draft, or the rest of the queue.
  "next_up_clicked",
] as const;
export type OnboardingStepName = (typeof ONBOARDING_STEPS)[number];

export function isOnboardingStep(value: unknown): value is OnboardingStepName {
  return typeof value === "string" && (ONBOARDING_STEPS as readonly string[]).includes(value);
}

/**
 * Written by the server alone, never accepted from the browser: each step is
 * kept once, so a client that said it first would take the slot. A run is
 * started by /api/onboard/start or the overnight provider retry, a trial by
 * Stripe's webhook, an approval by lib/articles/approve.ts.
 */
export const SERVER_ONLY_STEPS: readonly OnboardingStepName[] = ["site_added", "run_started", "trial_started", "article_approved"];

/** A step the browser may report (/api/onboard/step). */
export function isClientStep(value: unknown): value is OnboardingStepName {
  return isOnboardingStep(value) && !SERVER_ONLY_STEPS.includes(value);
}
