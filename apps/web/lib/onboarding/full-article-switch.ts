// ---------------------------------------------------------------------------
// PRETRIAL_FULL_ARTICLE: whether the owner reads the first article before the trial
// ---------------------------------------------------------------------------
//
// On by default since 2026-10-12 (founder decision): unset, empty and "1" are
// on; any other value, "0" first, is off. Read by the reader's routes
// (./first-article-body.ts), the setup page and the emails that describe it,
// so all of them say the same thing. Pure, no imports.

export const FULL_ARTICLE_SWITCH = "PRETRIAL_FULL_ARTICLE";

/** On unless switched off: unset (or empty) and "1" are on; any other value, "0" first, is off. */
export function fullArticleOn(env: Record<string, string | undefined> = process.env): boolean {
  const v = env[FULL_ARTICLE_SWITCH]?.trim();
  return v === undefined || v === "" || v === "1";
}
