// ---------------------------------------------------------------------------
// What the research drawer can do on this install, in words for a customer
// ---------------------------------------------------------------------------
//
// The drawer used to tell end users to "Set DATAFORSEO_API_KEY" and that
// "Chat needs ANTHROPIC_API_KEY on the server": operator instructions shown
// to people who do not run the server. The customer-facing sentence says what
// is missing for them; the variable name is appended only in development,
// where the person reading it is the one who can act on it.
//
// One place decides whether a provider is available, next to the check the
// pipeline already uses (lib/seo/client.ts), so the banner in the drawer and
// the note a run returns cannot disagree.

import { hasDataForSEOCredentials } from "@/lib/seo/client";

export function hasModelCredentials(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export { hasDataForSEOCredentials };

export const PROVIDER_UNAVAILABLE = "Keyword volumes aren't available on this account yet.";

function inDevelopment(): boolean {
  return process.env.NODE_ENV === "development";
}

/** Operator hint for the keyword provider, or null outside development. */
export function providerHint(): string | null {
  return inDevelopment() ? "Set DATAFORSEO_API_KEY (or DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD) on the server." : null;
}

/** Operator hint for the model, or null outside development. */
export function modelHint(): string | null {
  return inDevelopment() ? "Set ANTHROPIC_API_KEY on the server." : null;
}

function withHint(sentence: string, hint: string | null): string {
  return hint ? `${sentence} ${hint}` : sentence;
}

/** The note a run returns when the keyword provider cannot be reached at all. */
export function providerUnavailableNote(): string {
  return withHint(PROVIDER_UNAVAILABLE, providerHint());
}

/** The note for a feature that needs the model: "Chat isn't available yet." */
export function modelUnavailableNote(feature: string, alsoWorks?: string): string {
  const sentence = `${feature} isn't available yet.${alsoWorks ? ` ${alsoWorks}` : ""}`;
  return withHint(sentence, modelHint());
}
