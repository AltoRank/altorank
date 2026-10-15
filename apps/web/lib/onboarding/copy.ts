// ---------------------------------------------------------------------------
// Sentences the wizard has to keep true
// ---------------------------------------------------------------------------
//
// Pure, and here rather than inside wizard.tsx, because a claim derived from
// the account's state is exactly the kind of thing that should be asserted in
// a test rather than read off a screenshot.

import { TRIAL_DAYS } from "@/lib/stripe";

/**
 * The clause that reconciles the thirty-day plan with the free allowance.
 *
 * `buildPlan` fills a 30-day horizon at the site's pace, and FREE_TIER_PACE is
 * 7, so the wizard's "up to one article a day for the next 30 days" is
 * literally true and materially misleading: the monthly entitlement is
 * FREE_DRAFTS, so 23 of those 30 squares render grey with `frozenReason` the
 * first time the person opens the calendar. Nothing in the wizard said so
 * (P1-A1).
 *
 * Returns null when there is nothing to qualify - an unmetered account
 * (self-host, operator, an active plan), for which the plan and the
 * entitlement do not disagree.
 */
export function freeAllowanceClause(freeDrafts: number | null, opts: { preTrial?: boolean } = {}): string | null {
  if (freeDrafts === null || freeDrafts <= 0) return null;
  // Before the trial, setup writes one article and nothing reads it: the
  // trial is what opens the text (lib/billing/trial.ts, draftBodyLocked).
  // "The first 7 are free to read" was a promise the gate then broke.
  if (opts.preTrial) return `Setup writes your first article free; the ${TRIAL_DAYS}-day trial opens it and writes the rest.`;
  return `The first ${freeDrafts === 1 ? "one is" : `${freeDrafts} are`} free to read; the ${TRIAL_DAYS}-day trial writes the rest.`;
}

/** How long the wait after the wizard takes: the one estimate every screen quotes. */
export { FIRST_LOOK_MINUTES } from "./setup-progress";
import { FIRST_LOOK_MINUTES } from "./setup-progress";

/**
 * The wizard bar's promise, which has to be what the next three minutes
 * deliver (UX audit 2026-10-12, #5). It said "keywords, a 30-day plan" and
 * "your first article free", and the gate then showed one scheduled article
 * behind a lock. What is true now:
 *
 * - the run reads the site, picks the first topic and writes the first
 *   article on screen, in about FIRST_LOOK_MINUTES;
 * - before the trial, the account's owner reads it in full, free
 *   (PRETRIAL_FULL_ARTICLE, on by default: `canRead`); anyone else sees its
 *   shape until the trial opens it;
 * - the trial opens publishing and the rest of the drafts
 *   (lib/billing/trial.ts).
 *
 * `short` is the one line a phone has room for beside a full-width button.
 */
export function wizardNextLine(opts: { preTrial: boolean; canRead: boolean; freeDrafts: number | null }): { full: string; short: string } {
  const minutes = `about ${FIRST_LOOK_MINUTES} minutes`;
  if (opts.preTrial) {
    const lead = `Next: we read your site, pick your first topic and write your first article while you watch, in ${minutes}.`;
    return opts.canRead
      ? {
          full: `${lead} Read it free; the ${TRIAL_DAYS}-day trial lets you publish it and writes the rest.`,
          short: `About ${FIRST_LOOK_MINUTES} minutes. Read your first article free.`,
        }
      : {
          full: `${lead} The ${TRIAL_DAYS}-day trial opens it, lets you publish it and writes the rest.`,
          short: `About ${FIRST_LOOK_MINUTES} minutes. Watch your first article being written.`,
        };
  }
  const clause = freeAllowanceClause(opts.freeDrafts);
  return {
    full: `Next: we read your site, pick your first topics and write your first article while you watch, in ${minutes}.${clause ? ` ${clause}` : ""}`,
    short: `About ${FIRST_LOOK_MINUTES} minutes. Watch your first article being written.`,
  };
}
