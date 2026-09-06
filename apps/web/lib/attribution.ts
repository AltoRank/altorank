// ---------------------------------------------------------------------------
// Where the account heard of us
// ---------------------------------------------------------------------------
//
// One question, ten answers, asked once per account at the end of onboarding.
// The list lives here rather than in the database so the wizard, the Settings
// card and the validator read the same ten, in the same order, with the same
// words; migration 058 repeats the keys in a CHECK so nothing else can write a
// value the list does not know.
//
// "ai" is deliberately one bucket. People do not reliably remember which
// assistant they were talking to, and the number this exists to produce is
// "did an AI answer send this customer", not a league table of assistants.
// The order is the order we expect answers in, with the one we most want to
// learn about second, where it is seen but not leading the witness.

import type { IconName } from "@/components/ui/icons";

export const ATTRIBUTION_SOURCES = [
  { id: "google", label: "Google search", brand: "google" },
  { id: "ai", label: "ChatGPT or other AI", brand: "openai" },
  { id: "friend", label: "Friend or colleague", icon: "team" },
  { id: "linkedin", label: "LinkedIn", brand: "linkedin" },
  { id: "x", label: "X / Twitter", brand: "x" },
  { id: "youtube", label: "YouTube", brand: "youtube" },
  { id: "reddit", label: "Reddit", brand: "reddit" },
  { id: "newsletter", label: "Newsletter or article", icon: "articles" },
  { id: "podcast", label: "Podcast", icon: "voice" },
  { id: "other", label: "Other", icon: "more" },
] as const satisfies readonly ({ id: string; label: string } & ({ brand: string } | { icon: IconName }))[];

export type AttributionSource = (typeof ATTRIBUTION_SOURCES)[number]["id"];

export type Attribution = {
  source: AttributionSource;
  /** Only ever set for "other". */
  note: string | null;
};

/** Long enough for a sentence, short enough that nobody pastes a pitch. */
export const ATTRIBUTION_NOTE_MAX = 200;

export function isAttributionSource(value: unknown): value is AttributionSource {
  return typeof value === "string" && ATTRIBUTION_SOURCES.some((s) => s.id === value);
}

export function attributionLabel(source: AttributionSource): string {
  return ATTRIBUTION_SOURCES.find((s) => s.id === source)?.label ?? source;
}

/**
 * Turn what the screen sent into what the column accepts, or throw.
 *
 * "other" with nothing behind it is refused rather than stored: an "other"
 * with no words is a row we cannot learn from, and the screen has already
 * held the Continue button until the box has something in it. For every
 * source that is not "other" the note is dropped, whatever was sent, so a
 * stale sentence from a changed mind cannot survive next to a different
 * answer.
 */
export function parseAttribution(source: unknown, note: unknown): Attribution {
  if (!isAttributionSource(source)) {
    throw new Error("Pick one of the options.");
  }
  if (source !== "other") return { source, note: null };

  const text = typeof note === "string" ? note.trim() : "";
  if (!text) throw new Error("Say where, in a few words.");
  return { source, note: text.slice(0, ATTRIBUTION_NOTE_MAX) };
}
