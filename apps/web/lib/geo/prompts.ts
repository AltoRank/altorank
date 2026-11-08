// The rules for one buyer question in a site's prompt set (app/actions/geo.ts).

/** Questions per site. Ten is the intended set; the headroom is for swaps. */
export const GEO_PROMPT_LIMIT = 25;
export const GEO_PROMPT_MIN = 3;
export const GEO_PROMPT_MAX = 200;

/** Trimmed and single-spaced, or the reason it can't be asked. */
export function normaliseGeoPrompt(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const value = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (value.length < GEO_PROMPT_MIN) return { ok: false, error: "Type the question a buyer would ask." };
  if (value.length > GEO_PROMPT_MAX) {
    return { ok: false, error: `Keep it under ${GEO_PROMPT_MAX} characters, the way someone types it.` };
  }
  return { ok: true, value };
}
