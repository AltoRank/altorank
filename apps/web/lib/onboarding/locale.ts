// ---------------------------------------------------------------------------
// Labels people read, codes the database stores
// ---------------------------------------------------------------------------
//
// The wizard shows "Italian" and "Italy". `workspaces.language` is a locale
// code and `workspaces.location_code` is a DataForSEO location id, and both
// are read by every research call. Writing the label into the code column was
// the bug the first wizard shipped with; this is the one place the mapping
// lives so it cannot happen again.

import { LOCALES } from "@/lib/seo/locales";

export const GLOBAL_MARKET = "Global (English)";

/** Language options for a select: the label people see, the code we store. */
export const LANGUAGE_OPTIONS: { code: string; label: string }[] = Object.entries(LOCALES)
  .map(([code, e]) => ({ code, label: e.label }))
  .sort((a, b) => a.label.localeCompare(b.label));

/**
 * Markets: "Global" first, then each country we have a search location for.
 * The hint copy is the honest version of what "Global" means: US English
 * search data as the broadest international signal.
 */
export const MARKET_OPTIONS: { label: string; locationCode: number; hint?: string }[] = [
  { label: GLOBAL_MARKET, locationCode: 2840, hint: "Uses US English search data as the broadest international signal." },
  ...Array.from(
    new Map(Object.values(LOCALES).map((e) => [e.country, { label: e.country, locationCode: e.locationCode }])).values(),
  ).sort((a, b) => a.label.localeCompare(b.label)),
];

export interface ResolvedLocale {
  /** Key of `LOCALES`, e.g. "it", "en-gb". */
  language: string;
  /** DataForSEO location id, e.g. 2380 for Italy. */
  locationCode: number;
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Turn the wizard's two labels into what the workspace row needs.
 *
 * Tolerant on purpose: the model that proposes the profile writes "English",
 * "english", "en" or "English (UK)", and a person may type any of them. When
 * the market is a country we know, the country decides the location and the
 * language stays as chosen; when the market is Global or unknown, the
 * language's own default location is used.
 */
export function resolveLocale(languageLabel: string, marketLabel: string): ResolvedLocale {
  const lang = norm(languageLabel);
  const entries = Object.entries(LOCALES);
  const byLabel =
    entries.find(([, e]) => norm(e.label) === lang) ??
    entries.find(([code, e]) => code === lang || norm(e.languageCode) === lang) ??
    entries.find(([, e]) => norm(e.label).startsWith(lang) && lang.length >= 3) ??
    entries.find(([, e]) => norm(e.label).split(" ")[0] === lang.split(" ")[0]);
  const [code, entry] = byLabel ?? ["en", LOCALES.en];

  const market = norm(marketLabel);
  if (!market || market.startsWith("global")) {
    // Global means English/US data unless the language itself points elsewhere.
    return { language: code, locationCode: code === "en" ? 2840 : entry.locationCode };
  }
  const country = Object.values(LOCALES).find((e) => norm(e.country) === market);
  return { language: code, locationCode: country?.locationCode ?? entry.locationCode };
}

/** The reverse, for a wizard that reopens on a saved workspace. */
export function localeLabels(language: string | null | undefined, locationCode: number | null | undefined): { language: string; country: string } {
  const entry = LOCALES[language ?? "en"] ?? LOCALES.en;
  const country = Object.values(LOCALES).find((e) => e.locationCode === locationCode)?.country;
  return {
    language: entry.label,
    country: !locationCode || (locationCode === 2840 && entry.languageCode === "en") ? GLOBAL_MARKET : country ?? GLOBAL_MARKET,
  };
}
