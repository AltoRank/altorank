// ---------------------------------------------------------------------------
// Fact risk: does an article on this topic need facts the owner has not given?
// ---------------------------------------------------------------------------
//
// The first article goes out under the customer's name before anyone has
// read a word of it. Two of the first real drafts came back from the fact
// check high-risk for the same reason: the topic itself asked for clinical
// claims, or for the figures of a public incentive scheme, and the writer
// had nothing from the owner to state them from. The planner's first-article
// rule (./value-tiers.ts `chooseFirstArticle`) prefers a topic that needs
// neither, and says so when it cannot.
//
// Read from the topic's own words - the phrase, the planned headline and the
// reader's brief - never from the business profile alone: a clinic's article
// on its parking and opening hours is not a clinical claim. Two readings:
//
//   sensitive    health, legal, financial or safety, by the locale contract's
//                word lists (lib/content/trust.ts `sensitiveTopicOf`, asked
//                about the topic only)
//   rules        regulation or a public incentive (a law, an obligation, a
//                permit; a grant, a subsidy, a tax deduction), by the lists
//                below, in the same languages
//
// A year in the phrase is not a risk: it is a topic to refresh every year,
// and the first article says so in its review note (founder decision,
// 2026-09-30).
//
// Pure. Word lists are the vocabulary of each language, not anyone's
// keywords.

import { sensitiveTopicOf, type SensitiveKind } from "@/lib/content/trust";
import { foldCase, foldMarks, resolveLocale } from "@/lib/i18n/locale";

export type FactRiskKind = SensitiveKind | "regulation" | "incentive";

export interface FactRisk {
  kind: FactRiskKind;
  /** The words that decided it, for the review note. */
  evidence: string;
}

/**
 * Regulation and incentive words, folded (lower case, accents off), per
 * language. A stem ends in `\p{L}*`. Kept to words that mean the rule or the
 * scheme and little else: "aide", "ayuda", "prime" and "destek" (help,
 * premium, support) are left out on purpose, and so is a bare
 * "requirements" ("website requirements" is not a rule).
 */
const RULE_WORDS: Record<string, Record<"regulation" | "incentive", string[]>> = {
  en: {
    regulation: ["regulations?", "regulatory", "legislation", "compliance", "compliant", "mandatory", "obligations?", "permits?", "building codes?", "legal requirements?"],
    incentive: ["incentives?", "subsid\\p{L}*", "grants?", "rebates?", "tax credits?", "tax deductions?", "feed-in tariffs?"],
  },
  it: {
    regulation: ["normativ\\p{L}*", "regolament\\p{L}*", "obblig\\p{L}*", "legge", "leggi", "decreto", "decreti", "autorizzazion\\p{L}*", "permess\\p{L}*", "adempiment\\p{L}*"],
    incentive: ["incentiv\\p{L}*", "detrazion\\p{L}*", "agevolazion\\p{L}*", "fondo perduto", "bonus", "superbonus", "ecobonus", "sgrav\\p{L}*"],
  },
  es: {
    regulation: ["normativ\\p{L}*", "regulacion\\p{L}*", "reglament\\p{L}*", "obligatori\\p{L}*", "ley", "leyes", "decreto", "permisos?"],
    incentive: ["subvencion\\p{L}*", "incentivos?", "bonificacion\\p{L}*", "deduccion\\p{L}*", "desgravacion\\p{L}*"],
  },
  fr: {
    regulation: ["reglementation\\p{L}*", "obligatoire\\p{L}*", "obligations?", "loi", "lois", "decrets?", "autorisations?", "permis"],
    incentive: ["subventions?", "credit d'impot", "defiscalisation", "incitations? fiscales?"],
  },
  de: {
    regulation: ["vorschrift\\p{L}*", "verordnung\\p{L}*", "gesetz\\p{L}*", "pflicht\\p{L}*", "genehmigung\\p{L}*", "richtlinie\\p{L}*", "auflagen"],
    incentive: ["forderung\\p{L}*", "zuschuss\\p{L}*", "zuschusse", "subvention\\p{L}*", "steuerbonus"],
  },
  tr: {
    regulation: ["yonetmelik\\p{L}*", "mevzuat\\p{L}*", "kanun\\p{L}*", "zorunlu\\p{L}*", "ruhsat\\p{L}*", "yasal\\p{L}*"],
    incentive: ["tesvik\\p{L}*", "hibe\\p{L}*", "vergi indirim\\p{L}*"],
  },
};

const fold = (text: string) => foldMarks(foldCase(text));

function wordsIn(text: string, kind: "regulation" | "incentive", codes: readonly string[]): string[] {
  const alternatives = [...new Set(codes.flatMap((code) => RULE_WORDS[code]?.[kind] ?? []))];
  if (!alternatives.length) return [];
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}])`, "gu");
  return [...new Set([...fold(text).matchAll(re)].map((m) => m[0]))];
}

/**
 * Whether an article on this topic needs facts the owner has not given: a
 * clinical, legal, financial or safety claim, or a rule or incentive scheme's
 * terms. Null when it needs none that the word lists recognise.
 */
export function factRiskOf(input: {
  term: string;
  /** The planned headline and the reader's brief, when there is one. */
  angle?: string | null;
  buyingJob?: string | null;
  language?: string | null;
  profile?: unknown;
}): FactRisk | null {
  const locale = resolveLocale(input.language);
  const codes = locale.supported ? [...new Set([locale.code, "en"])] : Object.keys(RULE_WORDS);
  const topic = [input.term, input.angle ?? "", input.buyingJob ?? ""].join(" \n ");
  const sensitive = sensitiveTopicOf({ keyword: topic, profile: input.profile, language: input.language, topicOnly: true }).topic;
  if (sensitive) return { kind: sensitive.kind, evidence: sensitive.evidence };
  for (const kind of ["incentive", "regulation"] as const) {
    const words = wordsIn(topic, kind, codes);
    if (words.length) return { kind, evidence: `the topic names ${words.slice(0, 3).map((w) => `"${w}"`).join(", ")}` };
  }
  return null;
}

/** A calendar year in the phrase: the article is refreshed every year, not refused. */
export function namesYear(term: string): boolean {
  return /(?<!\d)(?:19|20)\d{2}(?!\d)/.test(term);
}
