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
 * What the server knows about setup before the trial, for the gate screen.
 * Read on the page (app/(setup)/onboarding/page.tsx); the screen only renders
 * it.
 *
 *   setupAllowed    the spend gate would let this account start setup again
 *                   (canSpend with action "setup" - the same question
 *                   /api/onboard/start asks before it starts one)
 *   firstAttempted  the one pre-trial article has been claimed: attempted,
 *                   whether or not it was written (claimPreTrialDraft)
 */
export type PreTrialSetup = { setupAllowed: boolean; firstAttempted: boolean };

/** Nothing about the trial stands in the way: self-host, a plan, an operator. */
export const OPEN_SETUP: PreTrialSetup = { setupAllowed: true, firstAttempted: false };

/**
 * Whether to offer running setup again.
 *
 * `run` null means setup never ran for this site (it was skipped), and then
 * the offer is the first run rather than a second one.
 *
 * Never when the spend gate would refuse it. A first draft that failed after
 * its research was bought keeps its claim, so setup cannot run again before
 * the trial - and the screen offered "Run setup again" anyway, a button the
 * server refused every time, with a sentence about a first article that did
 * not exist (round-5 review). The screen asks the gate's answer, not its own.
 */
export function offerSetupRetry(
  run: OnboardingState | null,
  fact: { hasArticle: boolean; writing: boolean; setupAllowed: boolean },
): boolean {
  if (fact.hasArticle || fact.writing) return false;
  if (!fact.setupAllowed) return false;
  if (!run) return true;
  return setupFellShort(run);
}

/**
 * The first article was attempted and there is none: its run failed after
 * the research was bought. The trial writes it, with the rest of the week;
 * until then the screen says so rather than offering a retry the gate refuses.
 */
export function firstArticleFailed(fact: { hasArticle: boolean; writing: boolean; firstAttempted: boolean }): boolean {
  return !fact.hasArticle && !fact.writing && fact.firstAttempted;
}
