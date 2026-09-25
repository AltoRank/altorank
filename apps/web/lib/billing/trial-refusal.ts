// ---------------------------------------------------------------------------
// What a trial-gated account is told, in one place
// ---------------------------------------------------------------------------
//
// An account that has not started its trial is refused three different
// things, and each has one sentence:
//
//   draft  asking for another article (session /api/generate for a new
//          keyword, Write now, the agent API and MCP generate, the crons):
//          the hold's sentence (lib/billing/trial-hold.ts)
//   body   asking to read or edit an article's text (the editor, its AI
//          actions, the agent API's content read, /api/generate into an
//          open draft, regenerating the first article): the body lock's
//          sentence (lib/billing/trial.ts, draftBodyLocked)
//   spend  anything else that costs a provider call once setup has written
//          the first article (keyword research, an audit, a rewrite, setup
//          run again): the spend gate's sentence (lib/billing/spend-gate.ts)
//
// The two were written by two tracks on the same day and lived in the files
// that enforce them. On the combined tree the session /api/generate answered
// a request for a NEW draft with the body lock's sentence while the agent API
// answered the same request with the hold's, so the same account read two
// reasons for one refusal depending on the door. Both sentences now live here
// and nowhere else (a guard test checks that no other file spells them out),
// so a door picks which question it is refusing and cannot word it its own way.

import { TRIAL_DAYS } from "@/lib/stripe";

/** The sentence every drafting door gives a held account, word for word. */
export const TRIAL_HOLD_MESSAGE =
  `Waiting for your trial to start. Your first article is written; nothing more is drafted until the ${TRIAL_DAYS}-day trial begins, ` +
  `and then the rest of this week's plan is written straight away.`;

/** The sentence every surface that holds an article's text gives a gated account. */
export const BODY_LOCKED_MESSAGE =
  `The article text opens when the ${TRIAL_DAYS}-day trial starts. Start it from the setup screen to read, approve and publish this draft.`;

/**
 * The sentence every paid door but drafting gives a gated account once setup
 * has written its first article. Setup itself spends before the trial (the
 * site read, the keyword research, the first draft); after it, nothing does.
 */
export const TRIAL_SPEND_MESSAGE =
  `Nothing more runs until the ${TRIAL_DAYS}-day trial starts. Setup has written your first article; ` +
  `start the trial from the setup screen to open research, audits and the rest of this week's drafts.`;

/** What the gated account asked for: another article, an existing article's text, or other paid work. */
export type TrialRefusalAsk = "draft" | "body" | "spend";

export function trialRefusal(ask: TrialRefusalAsk): string {
  if (ask === "draft") return TRIAL_HOLD_MESSAGE;
  if (ask === "body") return BODY_LOCKED_MESSAGE;
  return TRIAL_SPEND_MESSAGE;
}
