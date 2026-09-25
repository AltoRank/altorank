// ---------------------------------------------------------------------------
// When the setup screen may offer to run setup again
// ---------------------------------------------------------------------------
//
// A retry is the whole setup again: the site read, the keyword research, the
// plan and a draft, about $0.22 of provider calls. The gate screen used to
// offer it whenever the latest run's own record listed no draft - which is
// not the same thing as the site having no article. On a later visit the
// page said "draft not ready" while the email had already said it was, and
// "Try again" paid for a second setup to replace an article that existed.
//
// So the rule is two facts, both required:
//
//   no first article   a fact about the workspace (an article row exists),
//                      read by lib/onboarding/first-article.ts, and no article
//                      being written right now either
//   the run fell short it ended in error, stopped responding, produced
//                      nothing, or its draft step failed. A run that decided
//                      not to write (no keyword clear enough, the allowance
//                      spent) did its job; running it again buys the same
//                      answer.
//
// Pure and client-safe: the wizard reads it on the live run, the page on the
// stored one.

import { isTerminal, onboardingOutcome, stateFromRun, type OnboardingRunSnapshot, type OnboardingState } from "./events";

/** The stored run as the state the screen renders, or null when there has never been one. */
export function runStateOf(snapshot: OnboardingRunSnapshot | null | undefined): OnboardingState | null {
  if (!snapshot?.run) return null;
  return stateFromRun(snapshot.run, snapshot.article, { stale: snapshot.stale });
}

/** The run is over and did not do what setup is for. */
export function setupFellShort(state: OnboardingState): boolean {
  if (!isTerminal(state)) return false;
  const outcome = onboardingOutcome(state);
  if (outcome.tone === "error") return true;
  if (outcome.tone === "partial" && !outcome.produced) return true;
  return state.steps.some((s) => s.phase === "drafting" && s.status === "failed");
}

/**
 * Whether to offer running setup again.
 *
 * `run` null means setup never ran for this site (it was skipped), and then
 * the offer is the first run rather than a second one.
 */
export function offerSetupRetry(run: OnboardingState | null, fact: { hasArticle: boolean; writing: boolean }): boolean {
  if (fact.hasArticle || fact.writing) return false;
  if (!run) return true;
  return setupFellShort(run);
}
