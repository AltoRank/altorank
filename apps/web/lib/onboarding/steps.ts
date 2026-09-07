// ---------------------------------------------------------------------------
// The wizard's screens, by name, and the address of each one
// ---------------------------------------------------------------------------
//
// The wizard mirrors its step into `?step=` (components/onboarding/wizard.tsx)
// so Back, reload and a mailed link can all land on a specific screen. The
// list lives here rather than in the component because the email that brings
// a stalled account back (lib/email/lifecycle.ts, `setup_unfinished`) needs
// the number for the CMS screen and must not import a client component to get
// it.

export const SITE_STEPS = ["Business", "Audience & Competitors", "Blog", "Articles", "Integration"] as const;

export type SiteStep = (typeof SITE_STEPS)[number];

/** 0-based index of a screen, as the wizard's state holds it. */
export function stepIndex(step: SiteStep): number {
  return SITE_STEPS.indexOf(step);
}

/**
 * The wizard address that opens on `step`.
 *
 * `?step=` is 1-based because it is a thing a person can read in an address
 * bar; the first screen carries no query at all, matching what the wizard
 * writes when it moves back to it.
 */
export function wizardStepPath(step: SiteStep): string {
  const n = stepIndex(step) + 1;
  return n <= 1 ? "/onboarding" : `/onboarding?step=${n}`;
}
