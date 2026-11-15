// ---------------------------------------------------------------------------
// "What stopped you?": the one question asked of someone who did not start the trial
// ---------------------------------------------------------------------------
//
// By 2026-11-15 sixteen real signups had reached the trial offer or left
// before it, none had started a trial, and every reason on record was one we
// had inferred from the event log. This is the question, asked in two
// places: quietly under the offer on the gate, and in a follow-up email
// whose link opens /why. One pick; "Something else" takes a few words.
//
// Client-safe: the words and nothing else. The write is
// ./gate-answer-store.ts.

import { GATE_REASONS, type GateReason } from "./step-props";

/** A few sentences at most; longer is cut, not refused. */
export const GATE_ANSWER_NOTE_MAX = 500;

/** In the order shown. First person, the way the person would say it. */
export const GATE_REASON_LABELS: Record<GateReason, string> = {
  price: "It costs too much",
  card: "I don’t want to enter a card",
  quality: "The article wasn’t good enough",
  diy: "I can write these myself, or with ChatGPT",
  tool: "I only wanted the free tool",
  later: "Not now, maybe later",
  other: "Something else",
};

export function isGateReason(value: unknown): value is GateReason {
  return typeof value === "string" && (GATE_REASONS as readonly string[]).includes(value);
}

/** What the person typed, trimmed and bounded, or null when it is nothing. */
export function gateAnswerNote(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const note = raw.replace(/\s+/g, " ").trim().slice(0, GATE_ANSWER_NOTE_MAX);
  return note || null;
}
