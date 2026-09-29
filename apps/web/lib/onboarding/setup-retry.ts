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
 *   followUp        somebody will be told if the first look plans nothing
 *                   (lib/auth/operators.ts `followUpPromised`), so the screen
 *                   may promise the person a reply within 24 hours
 */
export type PreTrialSetup = { setupAllowed: boolean; firstAttempted: boolean; followUp: boolean };

/** Nothing about the trial stands in the way: self-host, a plan, an operator. */
export const OPEN_SETUP: PreTrialSetup = { setupAllowed: true, firstAttempted: false, followUp: false };

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

/**
 * How setup ended, as the screen before the trial has to say it. One answer,
 * read by the gate screen and the run screen alike, so neither can ask for a
 * card the other would not.
 *
 *   article          the first article exists: show its shape, ask for the card
 *   writing          it is being written right now
 *   retry            the run fell short and setup may run again
 *   first-failed     the one pre-trial article was attempted and failed on our
 *                    side; the trial writes it
 *   nothing-planned  the run finished without failing and nothing on the site
 *                    cleared the bar (runStatusFrom). No card ask: there is
 *                    nothing behind it, and a person follows up by email
 *   no-article       anything else that ended without an article
 *
 * `nothing-planned` exists because both real signups ended there on
 * 2026-09-28 and were shown "Setup finished without writing an article. The
 * trial opens the calendar" beside a card form, over an empty calendar.
 */
export type SetupEnding = "article" | "writing" | "retry" | "first-failed" | "nothing-planned" | "no-article";

export function setupEnding(
  run: OnboardingState | null,
  fact: { hasArticle: boolean; writing: boolean; setupAllowed: boolean; firstAttempted: boolean },
): SetupEnding {
  if (fact.hasArticle) return "article";
  if (fact.writing) return "writing";
  if (offerSetupRetry(run, fact)) return "retry";
  if (firstArticleFailed(fact)) return "first-failed";
  if (run && isTerminal(run) && onboardingOutcome(run).tone === "nothing_planned") return "nothing-planned";
  return "no-article";
}

/** Whether the screen asks for a card. Never over a run that planned nothing. */
export function asksForCard(ending: SetupEnding): boolean {
  return ending !== "nothing-planned";
}
