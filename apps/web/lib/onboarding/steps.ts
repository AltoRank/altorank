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

/**
 * The screen a `?step=` value asks for, 0-based, clamped to the screens that exist.
 *
 * `?step=` is 1-based because it is a thing a person can read in an address
 * bar. Absent, unparseable or out of range all mean the first screen, so a
 * hand-edited URL cannot render a blank wizard. Shared by the server page and
 * the client wizard so both paint the same screen on a deep link.
 */
export function stepFromParam(raw: string | null | undefined, count: number): number {
  const n = Number(raw);
  if (!raw || !Number.isInteger(n)) return 0;
  return Math.min(Math.max(n - 1, 0), count - 1);
}
