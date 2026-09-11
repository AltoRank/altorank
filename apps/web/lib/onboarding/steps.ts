// ---------------------------------------------------------------------------
// The wizard's address
// ---------------------------------------------------------------------------
//
// Onboarding was five screens until 2026-09-11 - Business, Audience &
// Competitors, Blog, Articles, About you - each mirrored into `?step=` so a
// mailed link could land on one. It is one screen now: everything the site
// read is shown at once, the two lists that feed keyword research open and the
// rest collapsed to a line, and the run starts from the same button. Article
// settings moved to Settings with their defaults, and the one question about
// the person moved to the trial ask, where it is one optional click.
//
// So there is no step to address any more. The lifecycle email that brings a
// stalled account back (lib/email/lifecycle.ts, `setup_unfinished`) still
// needs a path, and this is the one place it comes from.
export const ONBOARDING_PATH = "/onboarding";

/** Where to send someone to finish setting up. */
export function wizardStepPath(): string {
  return ONBOARDING_PATH;
}
