// ---------------------------------------------------------------------------
// "{rival} alternative": the seed a named rival is for
// ---------------------------------------------------------------------------
//
// The one page on altorank.co that earns clicks is /alternatives/distribb/
// (position 3.6, 21% CTR): a comparison with a rival its own size, on a
// results page the directories have not filled. Naming a rival in the wizard
// was meant to unlock that pattern, and did not: a rival's `ranked_keywords`
// are its own brand terms, which the buyer test rightly refuses, and the
// model's buyer seeds are category phrases. Nothing produced the phrase a
// buyer types when they are weighing the rival.
//
// So the phrase is produced here, from the rival's name, in the site's
// language. It is priced with the other seeds and treated like them: with
// measured volume or Search Console impressions it is planned like any topic;
// without either it is stored and never planned (lib/seo/recommendations.ts),
// and a Search Console connection can prove it later.

import { brandAliases } from "./seeds";

/**
 * How a buyer asks for a substitute, per language. English also goes in for
 * every market: on a non-English site the English phrasing is often the one
 * with the volume, and the buyer test still reads it against the business.
 */
const PATTERNS: Record<string, ReadonlyArray<(brand: string) => string>> = {
  en: [(b) => `${b} alternative`, (b) => `${b} alternatives`],
  it: [(b) => `alternativa ${b}`, (b) => `alternative a ${b}`],
  de: [(b) => `${b} alternative`, (b) => `alternative zu ${b}`],
  fr: [(b) => `alternative ${b}`, (b) => `alternative à ${b}`],
  es: [(b) => `alternativa ${b}`, (b) => `alternativas a ${b}`],
  pt: [(b) => `alternativa ${b}`, (b) => `alternativas ao ${b}`],
  nl: [(b) => `${b} alternatief`, (b) => `alternatief voor ${b}`],
};

/** The name a buyer would type: the domain's label, product suffix stripped ("revoo-app.com" -> "revoo"). */
export function rivalName(domain: string): string | null {
  // brandAliases returns [host, label, head], de-duplicated and floored at
  // three characters; the last entry after the host is the shortest wording
  // that still names the rival. A domain whose name is too short to be one
  // ("x.co") leaves only the host, and no phrase is made for it.
  const [, ...names] = brandAliases(domain);
  const head = names[names.length - 1]?.replace(/-/g, " ").trim();
  return head && head.length >= 3 ? head : null;
}

/**
 * The alternative-seeking phrases for each rival, de-duplicated, in the
 * site's language and in English.
 */
export function alternativeSeeds(rivals: readonly string[], languageCode: string): string[] {
  const lang = languageCode.toLowerCase().split("-")[0];
  const patterns = [...(PATTERNS[lang] ?? []), ...(lang === "en" ? [] : PATTERNS.en)];
  const out = new Set<string>();
  for (const rival of rivals) {
    const name = rivalName(rival);
    if (!name) continue;
    for (const p of patterns) out.add(p(name).toLowerCase());
  }
  return [...out];
}
