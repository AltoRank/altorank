// ---------------------------------------------------------------------------
// Fact risk: does an article on this topic need facts the owner has not given?
// ---------------------------------------------------------------------------
//
// The first article goes out under the customer's name before anyone has
// read a word of it. A topic that asks for a clinical claim (a diagnosis, a
// dose, a recovery time), a legal or financial figure, or the terms of a
// rule or a public incentive scheme leaves the writer stating facts nobody
// gave it, and such a draft comes back from the fact check high-risk. The
// planner's first-article rule (./value-tiers.ts `chooseFirstArticle`)
// prefers a topic that needs none, and says so when it cannot.
//
// Read from the topic's own words - the phrase and the planned headline, the
// article's task; not the brief's description of the searcher, which names
// their situation in the field's words - and only for CLAIM-shaped words:
// what an article on the topic would have to assert. Never the field's own
// vocabulary. A health business's every topic names its profession, its
// conditions and its patients, and reading those as risk made every one of
// its topics "risky", so the rule fell through to plan order for any health
// business (review, 2026-09-30). A condition explainer is such a business's
// ordinary article; "how long until it heals" is the claim.
//
//   clinical     diagnosis, dosage, medication, side effects, cure, recovery
//                or healing time
//   legal        legality, penalties, fines, liability
//   financial    tax or interest rates, tax brackets
//   safety       is it safe, dangerous, toxic
//   regulation   a law, an obligation, a permit
//   incentive    a grant, a subsidy, a tax deduction or credit
//
// A year in the phrase is not a risk: it is a topic to refresh every year,
// and the first article says so in its review note (founder decision,
// 2026-09-30).
//
// Pure. Word lists are the vocabulary of each language, not anyone's
// keywords.

import type { SensitiveKind } from "@/lib/i18n/locale";
import { foldCase, foldMarks, resolveLocale } from "@/lib/i18n/locale";

export type FactRiskKind = SensitiveKind | "regulation" | "incentive";

export interface FactRisk {
  kind: FactRiskKind;
  /** The words that decided it, for the review note. */
  evidence: string;
}

const KINDS: readonly FactRiskKind[] = ["health", "legal", "financial", "safety", "incentive", "regulation"];

/**
 * Claim words, folded (lower case, accents off), per language. A stem ends
 * in `\p{L}*`. Kept to words that name the claim and little else: a bare
 * "treatment", "therapy", "pain" or "clinic" is the field, not a claim, and
 * "aide", "ayuda", "prime" and "destek" (help, premium, support) or a bare
 * "requirements" ("website requirements") are left out on purpose.
 */
const CLAIM_WORDS: Record<string, Record<FactRiskKind, string[]>> = {
  en: {
    health: ["diagnos\\p{L}*", "dosage\\p{L}*", "doses?", "dosing", "medications?", "drugs?", "prescri\\p{L}*", "side effects?", "contraindicat\\p{L}*", "cures?", "cured", "curing", "(?:healing|recovery) (?:times?|timelines?|periods?)", "how long (?:does it take )?to (?:heal|recover)"],
    legal: ["is it legal", "illegal\\p{L}*", "penalt(?:y|ies)", "fines", "liabilit(?:y|ies)", "lawsuits?"],
    financial: ["tax rates?", "interest rates?", "tax brackets?", "how much tax"],
    safety: ["is it safe", "safe to", "dangerous", "toxic\\p{L}*", "poison\\p{L}*"],
    regulation: ["regulations?", "regulatory", "legislation", "compliance", "compliant", "mandatory", "obligations?", "permits?", "building codes?", "legal requirements?"],
    incentive: ["incentives?", "subsid\\p{L}*", "grants?", "rebates?", "tax credits?", "tax deductions?", "feed-in tariffs?"],
  },
  it: {
    health: ["diagnos\\p{L}*", "dosaggi\\p{L}*", "dosi", "farmac\\p{L}*", "medicinali", "prescri\\p{L}*", "effetti collaterali", "controindicazion\\p{L}*", "guarigione", "guarire", "tempi di recupero"],
    legal: ["e legale", "illegal\\p{L}*", "sanzion\\p{L}*", "multe", "multa"],
    financial: ["aliquot\\p{L}*", "tass[oi] di interesse"],
    safety: ["e sicuro", "pericolos\\p{L}*", "tossic\\p{L}*"],
    regulation: ["normativ\\p{L}*", "regolament\\p{L}*", "obblig\\p{L}*", "legge", "leggi", "decreto", "decreti", "autorizzazion\\p{L}*", "permess\\p{L}*", "adempiment\\p{L}*"],
    incentive: ["incentiv\\p{L}*", "detrazion\\p{L}*", "agevolazion\\p{L}*", "fondo perduto", "bonus", "superbonus", "ecobonus", "sgrav\\p{L}*"],
  },
  es: {
    health: ["diagnos\\p{L}*", "dosis", "medicament\\p{L}*", "farmac\\p{L}*", "efectos secundarios", "contraindicacion\\p{L}*", "curar", "tiempo de recuperacion"],
    legal: ["es legal", "ilegal\\p{L}*", "sancion\\p{L}*", "multas?"],
    financial: ["(?:tipos?|tasas?) de interes", "tipos? impositivos?"],
    safety: ["es seguro", "peligros\\p{L}*", "toxic\\p{L}*"],
    regulation: ["normativ\\p{L}*", "regulacion\\p{L}*", "reglament\\p{L}*", "obligatori\\p{L}*", "ley", "leyes", "decreto", "permisos?"],
    incentive: ["subvencion\\p{L}*", "incentivos?", "bonificacion\\p{L}*", "deduccion\\p{L}*", "desgravacion\\p{L}*"],
  },
  fr: {
    health: ["diagnostic\\p{L}*", "posologie", "doses?", "medicament\\p{L}*", "effets secondaires", "contre-indication\\p{L}*", "guerir", "guerison", "temps de recuperation"],
    legal: ["est-ce legal", "illegal\\p{L}*", "amendes?", "sanctions?"],
    financial: ["taux d'interet", "taux d'imposition", "tranches? d'imposition"],
    safety: ["dangereu\\p{L}*", "toxique\\p{L}*"],
    regulation: ["reglementation\\p{L}*", "obligatoire\\p{L}*", "obligations?", "loi", "lois", "decrets?", "autorisations?", "permis"],
    incentive: ["subventions?", "credit d'impot", "defiscalisation", "incitations? fiscales?"],
  },
  de: {
    health: ["diagnos\\p{L}*", "dosierung\\p{L}*", "medikament\\p{L}*", "arzneimittel\\p{L}*", "nebenwirkung\\p{L}*", "kontraindikation\\p{L}*", "heilungsdauer"],
    legal: ["illegal\\p{L}*", "bussgeld\\p{L}*", "haftung\\p{L}*"],
    financial: ["zinssatz\\p{L}*", "steuersatz\\p{L}*"],
    safety: ["gefahrlich\\p{L}*", "giftig\\p{L}*"],
    regulation: ["vorschrift\\p{L}*", "verordnung\\p{L}*", "gesetz\\p{L}*", "pflicht\\p{L}*", "genehmigung\\p{L}*", "richtlinie\\p{L}*", "auflagen"],
    incentive: ["forderung\\p{L}*", "zuschuss\\p{L}*", "zuschusse", "subvention\\p{L}*", "steuerbonus"],
  },
  tr: {
    health: ["teshis\\p{L}*", "dozaj\\p{L}*", "ilac\\p{L}*", "yan etki\\p{L}*", "recete\\p{L}*", "iyilesme sure\\p{L}*"],
    legal: ["yasadisi", "yasal mi", "ceza\\p{L}*"],
    financial: ["faiz oran\\p{L}*", "vergi oran\\p{L}*"],
    safety: ["tehlikeli\\p{L}*", "zehirli\\p{L}*", "zararli mi"],
    regulation: ["yonetmelik\\p{L}*", "mevzuat\\p{L}*", "kanun\\p{L}*", "zorunlu\\p{L}*", "ruhsat\\p{L}*", "yasal\\p{L}*"],
    incentive: ["tesvik\\p{L}*", "hibe\\p{L}*", "vergi indirim\\p{L}*"],
  },
};

const fold = (text: string) => foldMarks(foldCase(text));

function claimsIn(text: string, kind: FactRiskKind, codes: readonly string[]): string[] {
  const alternatives = [...new Set(codes.flatMap((code) => CLAIM_WORDS[code]?.[kind] ?? []))];
  if (!alternatives.length) return [];
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}])`, "gu");
  return [...new Set([...fold(text).matchAll(re)].map((m) => m[0]))];
}

/**
 * Whether an article on this topic needs facts the owner has not given: a
 * clinical, legal, financial or safety claim, or a rule or incentive
 * scheme's terms. Null when it needs none that the word lists recognise.
 */
export function factRiskOf(input: {
  term: string;
  /** The planned headline, when there is one. */
  angle?: string | null;
  language?: string | null;
}): FactRisk | null {
  const locale = resolveLocale(input.language);
  const codes = locale.supported ? [...new Set([locale.code, "en"])] : Object.keys(CLAIM_WORDS);
  const topic = [input.term, input.angle ?? ""].join(" \n ");
  for (const kind of KINDS) {
    const found = claimsIn(topic, kind, codes);
    if (found.length) return { kind, evidence: `the topic names ${found.slice(0, 3).map((w) => `"${w}"`).join(", ")}` };
  }
  return null;
}

/** A calendar year in the phrase: the article is refreshed every year, not refused. */
export function namesYear(term: string): boolean {
  return /(?<!\d)(?:19|20)\d{2}(?!\d)/.test(term);
}
