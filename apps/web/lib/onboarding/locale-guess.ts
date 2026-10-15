// ---------------------------------------------------------------------------
// Language and market, guessed when the site read fails
// ---------------------------------------------------------------------------
//
// When the profile read fails the wizard used to start from EMPTY_PROFILE,
// which says English / Global. For an Italian clinic or a Turkish agency that
// is a plan and an article for the wrong market, and nothing on the screen
// pointed at the two fields that would explain it (UX audit 2026-10-12, #15).
//
// Two signals the site gives away even when it cannot be described: the
// `lang` on its <html> (the language it is written in) and its country domain
// (.it, .tr, .de ...: the market it sells in). The page's own `lang` decides
// the language; the country domain decides the market; each fills in for the
// other when it is missing. Neither is a claim about the business, and the
// wizard shows both, always, with a Change link.
//
// Pure and import-light: the server action calls it, the tests call it, and
// the labels it returns are the ones the wizard's selects hold.

import { LOCALES } from "@/lib/seo/locales";

export interface LocaleGuess {
  /** A LANGUAGE_OPTIONS label, e.g. "Italian". */
  language: string;
  /** A MARKET_OPTIONS label, e.g. "Italy". */
  country: string;
}

/** The `lang` on a page's <html>, as written ("it-IT"), or null. */
export function htmlLangOf(html: string | null | undefined): string | null {
  if (!html) return null;
  const tag = html.match(/<html\b[^>]*>/i)?.[0];
  if (!tag) return null;
  const lang = tag.match(/\blang\s*=\s*["']?([a-zA-Z]{2,3}(?:[-_][a-zA-Z0-9]{2,8})*)/i)?.[1];
  return lang ? lang.replace(/_/g, "-") : null;
}

/**
 * Country domains to the LOCALES key whose market they are. Only countries
 * LOCALES has a search location for: a guess the selects cannot hold would
 * be shown as one thing and saved as another.
 */
const CC_TLD: Record<string, string> = {
  it: "it",
  tr: "tr",
  de: "de",
  fr: "fr",
  es: "es",
  nl: "nl",
  pl: "pl",
  se: "sv",
  dk: "da",
  no: "no",
  fi: "fi",
  pt: "pt-pt",
  br: "pt",
  mx: "es-mx",
  uk: "en-gb",
  au: "en-au",
  ca: "en-ca",
  jp: "ja",
  kr: "ko",
  cn: "zh",
  tw: "zh-tw",
  sa: "ar",
  ru: "ru",
  cz: "cs",
  ro: "ro",
  hu: "hu",
  gr: "el",
  th: "th",
  vn: "vi",
  id: "id",
  my: "ms",
  il: "he",
  ua: "uk",
};

/** BCP 47 regions to the same keys, for `lang="de-DE"` on a .com. */
const REGION: Record<string, string> = { ...CC_TLD, gb: "en-gb", us: "en", se: "sv", dk: "da" };

/** The LOCALES key for a primary language subtag ("it" -> "it"), or null. */
function languageKey(primary: string, region: string | null): string | null {
  const p = primary.toLowerCase();
  // A regional variant LOCALES carries as its own entry ("en-gb", "pt-pt").
  if (region) {
    const regional = `${p}-${region.toLowerCase()}`;
    if (LOCALES[regional]) return regional;
  }
  if (LOCALES[p]) return p;
  // Hebrew's legacy code, Norwegian Bokmål and Nynorsk.
  const alias: Record<string, string> = { iw: "he", nb: "no", nn: "no", in: "id" };
  return alias[p] ?? null;
}

/** The country domain of a host ("acme.it" -> "it", "acme.co.uk" -> "uk"), or null. */
function ccTldOf(domain: string): string | null {
  const host = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  const tld = host.split(".").pop() ?? "";
  return CC_TLD[tld] ? tld : null;
}

/**
 * The language and market a site most likely writes for, or null when it
 * gives nothing away (an English page on a .com: the defaults already say so).
 */
export function guessLocale({ htmlLang, domain }: { htmlLang?: string | null; domain: string }): LocaleGuess | null {
  const [primary, region] = (htmlLang ?? "").split("-");
  const regionKey = region && /^[a-z]{2}$/i.test(region) ? REGION[region.toLowerCase()] ?? null : null;
  const fromLang = primary ? languageKey(primary, region && /^[a-z]{2}$/i.test(region) ? region : null) : null;
  const tld = ccTldOf(domain);
  const fromTld = tld ? CC_TLD[tld] : null;

  // The language: the page's own word for it; the country domain's when the
  // page says nothing.
  const langKey = fromLang ?? fromTld;
  // The market: the country domain; then the region the page names; then,
  // for a language that is not English, its own country (what resolveLocale
  // would pick for "Global" anyway, said out loud).
  const marketKey = fromTld ?? regionKey ?? (langKey && LOCALES[langKey].languageCode !== "en" ? langKey : null);

  // Nothing, or English with no country: the defaults are the honest answer.
  if (!marketKey) return null;
  return { language: LOCALES[langKey ?? marketKey].label, country: LOCALES[marketKey].country };
}
