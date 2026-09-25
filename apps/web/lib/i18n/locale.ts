// ---------------------------------------------------------------------------
// The locale contract: every rule that depends on the article's language
// ---------------------------------------------------------------------------
//
// A real signup on 2026-09-22 (a Turkish web and mobile agency) got a first
// draft written in fluent Turkish, and then the pipeline wrote English into
// it and read it with English eyes: a table of contents headed "Contents", a
// closing "Learn more about… / This article is published by…", English alt
// text on every section image; a voice profile that never noticed the brand
// speaks as "biz" (we); a fact checker that could not see "%20", "yüzde 20",
// "₺1.500,50" or "Gartner'a göre"; SEO and AEO scores computed with English
// sentence and keyword rules; heading anchors garbled by a slugifier that
// dropped the dotless ı ("yazılım" -> "yaz-l-m").
//
// None of that was one bug. Language support was decided module by module -
// the labels file knew five languages, the fact checker one, the voice
// analyser one, the slugifier none - and every module fell back to English
// without saying so. This file is the one place a language is described, and
// every module that reads or writes article text in a language reads it here.
//
// The rules:
//
//   A language is supported when it has an entry in RULES below, complete:
//   the type makes a half-described language impossible.
//
//   An unsupported language is explicit. `resolveLocale` returns
//   `{ supported: false }` for it, and each consumer decides, in writing,
//   what it does instead: omit the element (enrichment), mark the check
//   "not checked for <language>" (scorers, audit, voice), return an
//   `unchecked` verdict (fact check), or ask the model to write the label in
//   the article's language (prompts). Never English text inside a
//   non-English article, never a score computed with English rules on
//   non-English text.
//
//   An omitted language is English. `workspaces.language` is NOT NULL
//   DEFAULT 'en' (migration 004) and constrained to a code (049), so every
//   production caller has one to pass; `lib/i18n/__tests__/locale-guard`
//   fails when a production caller of a language-dependent entry point does
//   not pass it. The default exists for tests and scripts, not as a fallback.
//
//   Labels this product WRITES come from the article's language only.
//   Headings and labels this product RECOGNISES (a FAQ heading, a sources
//   footer, "click here") are matched in every supported language, because
//   recognising a known label is never a misreading. Prose rules (who is
//   cited, what is a figure, what is a definition) use the article's
//   language only.

import { LOCALES } from "@/lib/seo/locales";
import type { ImageStyle } from "@/lib/onboarding/output-settings";

export const SUPPORTED_LANGUAGES = ["en", "it", "es", "fr", "de", "tr"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** Time units the infographic step can chart, in their canonical form. */
export type TimeUnit = "hours" | "minutes" | "seconds" | "days" | "weeks" | "months" | "years";

// ── Shapes ──────────────────────────────────────────────────────────────────

/** Fixed strings the product writes INTO an article. */
export interface ArticleLabels {
  /** Table of contents heading and its nav's aria-label. */
  contents: string;
  /** Prefix of a video caption: "Video: <title> (<channel>, YouTube)". */
  video: string;
  /** Opens an infographic caption, before the quoted source sentence. */
  figuresFrom: string;
  /** The chart's aria-label, around the plain-text list of its values. */
  barChart: (description: string) => string;
  /** The closing call to action's heading. */
  learnMore: (name: string) => string;
  /** The first sentence of the closing call to action. */
  publishedBy: (name: string) => string;
  /** The second sentence; `{link}` is where the site's link goes. */
  visit: string;
  /** Alt-text prefix for a generated section image, per style preset. */
  illustration: Record<ImageStyle, string>;
  /** The summary block's heading the prompt offers the writer. */
  keyTakeaways: string;
  /** The FAQ section's heading the prompt asks for. */
  faqHeading: string;
  /** Bar labels for a before/after chart whose sentence has no words for them. */
  before: string;
  after: string;
}

/** How figures are written. Read by the fact checker, the citation check, the AEO scorer and the infographic step. */
export interface NumberRules {
  decimal: "." | ",";
  /** Thousands separator. */
  group: "," | "." | " ";
  /** Regex fragment for a number's digits as this language writes them. */
  digits: string;
  /** "%" before the number ("%20") as well as after it. */
  percentSignBefore: boolean;
  /** Words after a number that make it a percentage ("20 percent"). Lowercase literals. */
  percentWordsAfter: string[];
  /** Words before a number that make it a percentage ("yüzde 20"). Lowercase literals. */
  percentWordsBefore: string[];
  /** Currency written after the amount ("1.500 TL"). Regex fragments. */
  currencyAfter: string[];
  /** Currency symbols also written after the amount ("1.500 €"). */
  symbolAfter: boolean;
  /** Scale words that make a count large ("million", "milyon"). Regex fragments. */
  scaleWords: string[];
  /** Nouns a large count is a count OF, so "200 words" is not a market claim. Regex fragments. */
  countNouns: string[];
  /** "3 times faster", "3 kat daha". Regex fragments that follow the number. */
  multiplierWords: string[];
  /** Time units as written, per canonical unit. Regex fragments. */
  timeUnits: Record<TimeUnit, string[]>;
  /** Time units as the chart writes them. */
  timeUnitLabels: Record<TimeUnit, string>;
  /** "per month" and its kin, which ride along with a price. Regex fragment. */
  perPeriod: string;
  /** A percentage as this language prints it. */
  formatPercent: (n: string) => string;
  /**
   * "from 42% to 61%". Named groups: `a`/`b` the two numbers, `ca`/`cb` a
   * currency or % before them, `ua`/`ub` a unit after them, and optionally
   * `from`/`to`, the sentence's own words for the two bars.
   */
  beforeAfter: RegExp;
}

/** Rules for reading prose. Applied to text lowered with `Locale.lower` unless noted. */
export interface ProseRules {
  /** Who a claim is attributed to. Applied to RAW text (case matters); group 1 is the source. */
  attribution: RegExp[];
  /** A sentence that states a figure and names where it came from (bolded by the format step). */
  citableClaim: RegExp;
  /** "Studies show": an appeal to evidence, a fact-check claim when nothing is named. Applied to raw text, case-insensitive. */
  evidenceAppeal: RegExp;
  /** The audit's broader "unnamed evidence" (adds experts, "it is well known"). */
  hollowEvidence: RegExp;
  /** "#1", "market leader". Applied to raw text, case-insensitive. */
  superlative: RegExp;
  /** Openers that announce a section instead of answering it. Anchored at the start. */
  announcementOpener: RegExp;
  /** A definition's verb. */
  definition: RegExp;
  /**
   * Where the definition verb sits: in the opening of the paragraph for
   * languages that put the verb second ("X is..."), at the end of the first
   * sentence for verb-final ones ("X ... bir yöntemdir").
   */
  definitionAt: "opening" | "firstSentenceEnd";
  /** "We tested", "in our experience". */
  firstHand: RegExp;
  /** "Written by", "Author:". */
  byline: RegExp;
  /** "Image of X": the wrapper an alt text puts round a keyword without describing anything. */
  pictureOf: RegExp;
  /** Abbreviations whose dot does not end a sentence. Regex fragments, without the dot. */
  abbreviations: string[];
}

/** Headings and labels the product recognises. Matched in every supported language. */
export interface HeadingRules {
  faq: RegExp;
  summary: RegExp;
  /** Sections that summarise or list rather than explain: no image drawn from them. */
  notIllustrated: RegExp;
  howTo: RegExp;
  /** Whole-heading labels that open a citation list. Lowercase. */
  sourcesFooter: string[];
  /** Anchor text that says nothing about the destination. Lowercase. */
  genericAnchors: string[];
}

/** Markers the local voice analyser reads. */
export interface VoiceMarkers {
  /** "we", "our", and in Turkish the -iz / -imiz suffixes that carry them. */
  firstPersonPlural: RegExp;
  /** Applied to RAW text: English "I" is only a pronoun in capitals. */
  firstPersonSingular: RegExp;
  directAddress: RegExp;
  /** Imperatives and prohibitions: "don't", "never", "asla". */
  direct: RegExp;
  /** Register-marking contractions; null where the language has none. */
  contractions: RegExp | null;
}

export interface LocaleRules {
  code: SupportedLanguage;
  /** English name, for prompts and for "not checked for <language>". */
  name: string;
  /** Tag for case mapping and number formatting. */
  bcp47: string;
  labels: ArticleLabels;
  numbers: NumberRules;
  prose: ProseRules;
  headings: HeadingRules;
  voice: VoiceMarkers;
  /**
   * How many words this language takes for what English says in one, for
   * the thresholds that count words (sentence length, paragraph length,
   * alt-text floor, words per citation). The bands in the scorers were set
   * for English; a language that packs into fewer words must not pass them
   * more easily, which is what happened to the Turkish draft.
   */
  wordScale: number;
  /**
   * How a keyword is found in running text: as whole words, or as a stem that
   * suffixes may follow ("web tasarım" in "web tasarımında").
   */
  keywordMatch: "word" | "stem";
}

export interface SupportedLocale extends LocaleRules {
  supported: true;
  /** Lowercase by this language's rules (Turkish İ -> i, I -> ı). */
  lower: (text: string) => string;
}

export interface UnsupportedLocale {
  supported: false;
  /** The primary language subtag we were given, e.g. "ja". */
  code: string;
  name: string;
  bcp47: string;
  lower: (text: string) => string;
}

export type Locale = SupportedLocale | UnsupportedLocale;

// ── Regex building ──────────────────────────────────────────────────────────
//
// JavaScript's `\b` knows only ASCII letters, with or without the `u` flag:
// `\bè\b` never matches and `\bcittà\b` fails at the end of the word. These
// boundaries are Unicode letters and digits.

const B = String.raw`(?<![\p{L}\p{N}_])`;
const E = String.raw`(?![\p{L}\p{N}_])`;

/** Any of `alternatives` as a whole word. Alternatives are regex fragments. */
export function wordsRegex(alternatives: string[], flags = "iu"): RegExp {
  return new RegExp(`${B}(?:${alternatives.join("|")})${E}`, flags);
}

/** Escape a literal for use inside a regex. */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Literal phrases as regex alternatives, any run of whitespace between their words. */
export function phrasePattern(phrases: string[]): string {
  return phrases.map((p) => escapeRegex(p).replace(/ +/g, String.raw`\s+`)).join("|");
}

// ── English ─────────────────────────────────────────────────────────────────
//
// The rules the product already had, moved here verbatim where they were
// English, so English articles score, check and read exactly as before.

const EN_NAME = String.raw`\p{Lu}[\p{L}\p{N}&.'’-]*`;

const EN: LocaleRules = {
  code: "en",
  name: "English",
  bcp47: "en",
  wordScale: 1,
  keywordMatch: "word",
  labels: {
    contents: "Contents",
    video: "Video",
    figuresFrom: "Figures from the text:",
    barChart: (d) => `Bar chart: ${d}`,
    learnMore: (name) => `Learn more about ${name}`,
    publishedBy: (name) => `This article is published by ${name}.`,
    visit: "Visit {link}.",
    illustration: {
      sketch: "Sketch illustrating",
      watercolor: "Watercolour illustration of",
      realistic: "Photo-style image illustrating",
      illustration: "Illustration of",
      "brand-text": "Graphic illustrating",
    },
    keyTakeaways: "Key takeaways",
    faqHeading: "Frequently asked questions",
    before: "Before",
    after: "After",
  },
  numbers: {
    decimal: ".",
    group: ",",
    digits: String.raw`\d[\d.,]*`,
    percentSignBefore: false,
    percentWordsAfter: ["percent", "per cent"],
    percentWordsBefore: [],
    currencyAfter: ["USD", "EUR", "GBP"],
    symbolAfter: false,
    scaleWords: ["k", "m", "bn", "b", "billion", "million", "thousand"],
    countNouns: ["users", "customers", "clients", "companies", "businesses", "websites", "sites", "people", "searches", "queries", "visitors", "downloads"],
    multiplierWords: [String.raw`times\s+(?:more|less|faster|slower|higher|lower|better|worse)`],
    timeUnits: {
      hours: ["hours?", "hrs?"],
      minutes: ["minutes?", "mins?"],
      seconds: ["seconds?", "secs?"],
      days: ["days?"],
      weeks: ["weeks?"],
      months: ["months?"],
      years: ["years?"],
    },
    timeUnitLabels: { hours: "hours", minutes: "minutes", seconds: "seconds", days: "days", weeks: "weeks", months: "months", years: "years" },
    perPeriod: String.raw`(?:per|a|\/)\s*(?:month|year|week|day|user|seat|mo|yr)\b`,
    formatPercent: (n) => `${n}%`,
    beforeAfter: new RegExp(
      String.raw`\b(?<from>from)\s+(?<ca>[€$£])?\s?(?<a>\d[\d.,]*)\s?(?<ua>[%€$£]|percent|hours?|days?|weeks?|months?|minutes?|seconds?)?\s+(?<to>to)\s+(?<cb>[€$£])?\s?(?<b>\d[\d.,]*)\s?(?<ub>[%€$£]|percent|hours?|days?|weeks?|months?|minutes?|seconds?)?`,
      "i",
    ),
  },
  prose: {
    attribution: [
      new RegExp(String.raw`\b[Aa]ccording to\s+(?:the\s+)?(${EN_NAME}(?:\s+${EN_NAME}){0,4})`, "u"),
      new RegExp(String.raw`\b(?:[Rr]eported|[Pp]ublished|[Cc]onducted|[Cc]ompiled)\s+by\s+(${EN_NAME}(?:\s+${EN_NAME}){0,4})`, "u"),
      new RegExp(String.raw`\b(?:[Ss]tudy|[Ss]urvey|[Rr]eport|[Rr]esearch|[Aa]nalysis|[Dd]ata)\s+(?:from|by)\s+(?:the\s+)?(${EN_NAME}(?:\s+${EN_NAME}){0,4})`, "u"),
      new RegExp(String.raw`(?<![\p{L}\p{N}])(${EN_NAME}(?:\s+${EN_NAME}){0,3})['’]s\s+(?:study|survey|report|research|data|analysis)\b`, "u"),
      new RegExp(String.raw`(?<![\p{L}\p{N}])(\p{Lu}[\p{L}\p{N}&.'’-]+(?:\s+\p{Lu}[\p{L}\p{N}&.'’-]+){0,3})\s+(?:reports?|reported|estimates?|estimated|predicts?|predicted|found|states?|stated)\b`, "u"),
    ],
    citableClaim:
      /\d[\d.,]*\s?(%|percent|per cent|million|billion|k\b|x\b|€|\$|£|hours?|days?|weeks?|months?|years?)?[^.!?]*?\b(according to|per|reports?|reported|found that|survey(?:ed)? by|data from|study by|research by|estimates?)\b|\b(according to|per|reports?|reported|found that|survey(?:ed)? by|data from|study by|research by)\b[^.!?]*?\d/i,
    evidenceAppeal:
      /(?<!\b(?:your|their|our|its|my|his|her)\s)\b(?:studies|study|surveys?|research|reports?|data|analysis)\s+(?:show|shows|showed|find|finds|found|reveal|reveals|revealed|suggest|suggests|indicate|indicates|confirm|confirms)\b/gi,
    hollowEvidence:
      /\b(?:studies|study|research|surveys?|experts?|data|reports?)\s+(?:show|shows|suggest|suggests|agree|agrees|found|find|finds|indicate|indicates|confirm|confirms|reveal|reveals)\b|\bit is well[- ]known\b|\bmost experts\b|\bexperts recommend\b/gi,
    superlative:
      /\b(?:the\s+)?(?:#1|number one|world'?s\s+(?:largest|biggest|leading|most\s+popular)|industry[- ]leading|market leader|fastest[- ]growing)\b/gi,
    announcementOpener:
      /^(in this (section|part|article|guide|post)|let'?s|before (we|you|diving)|now that|when it comes to|in today'?s|there are (many|several|a number of)|it'?s (important|worth|no secret)|as (we|you) (mentioned|saw|know)|first,? let|welcome)/i,
    definition: /\b(is|are|refers to|means)\b/,
    definitionAt: "opening",
    firstHand:
      /\b(?:we tested|we tried|in our (?:tests?|experience|testing)|i tested|i tried|when we (?:ran|used|switched)|our team (?:used|ran|found))\b/i,
    byline: /\b(?:about the author|written by|author:)/i,
    pictureOf:
      /^(?:an?\s+|the\s+)?(?:image|picture|photo|photograph|illustration|graphic|screenshot|diagram|chart|infographic|icon|logo)\s+(?:of|showing|about|for)\s+(?:an?\s+|the\s+)?/i,
    abbreviations: ["e\\.g", "i\\.e", "etc", "vs", "Dr", "Mr", "Mrs", "Ms", "Prof", "Inc", "Ltd", "Co", "St", "approx", "no"],
  },
  headings: {
    faq: /\bfaqs?\b|frequently asked/i,
    summary: /\b(?:tl;?\s?dr|key takeaways?|in short|at a glance|quick answer|the short version)\b/i,
    notIllustrated: /key takeaways?|summary|tl;?dr|conclusion|final thoughts|\bfaqs?\b|frequently asked|references|sources|further reading/i,
    howTo:
      /^(how to|how do|how can|how should|steps? to|step[- ]by[- ]step|setting up|getting started|installing|configuring)\b|\b(tutorial|walkthrough)\b/i,
    sourcesFooter: [
      "sources", "source", "references", "reference", "citations", "bibliography",
      "works cited", "further reading", "sources and references", "sources & references",
      "references and sources", "sources cited",
    ],
    genericAnchors: [
      "here", "click here", "this", "this article", "this post", "this page", "link",
      "read more", "learn more", "more", "website", "source", "see more",
    ],
  },
  voice: {
    firstPersonPlural: /\b(we|our|us)\b/i,
    firstPersonSingular: /\b(I|my|me)\b/,
    directAddress: /\b(you|your)\b/i,
    direct: /\b(don't|won't|stop|never|avoid)\b/i,
    contractions: /\b(don't|won't|can't|isn't|aren't|we're|they're|it's|that's|we've)\b/i,
  },
};

// ── Italian ─────────────────────────────────────────────────────────────────

const LATIN_NAME = String.raw`\p{Lu}[\p{L}\p{N}&.'’-]*`;
const NAME_RUN = (n: number) => String.raw`${LATIN_NAME}(?:\s+${LATIN_NAME}){0,${n}}`;

const IT: LocaleRules = {
  code: "it",
  name: "Italian",
  bcp47: "it",
  wordScale: 1,
  keywordMatch: "word",
  labels: {
    contents: "Indice",
    video: "Video",
    figuresFrom: "Dati tratti dal testo:",
    barChart: (d) => `Grafico a barre: ${d}`,
    learnMore: (name) => `Scopri di più su ${name}`,
    publishedBy: (name) => `Questo articolo è pubblicato da ${name}.`,
    visit: "Visita {link}.",
    illustration: {
      sketch: "Schizzo che illustra",
      watercolor: "Acquerello che illustra",
      realistic: "Immagine fotografica che illustra",
      illustration: "Illustrazione di",
      "brand-text": "Grafica che illustra",
    },
    keyTakeaways: "Punti chiave",
    faqHeading: "Domande frequenti",
    before: "Prima",
    after: "Dopo",
  },
  numbers: {
    decimal: ",",
    group: ".",
    digits: String.raw`\d[\d.,]*`,
    percentSignBefore: false,
    percentWordsAfter: ["per cento", "percento"],
    percentWordsBefore: [],
    currencyAfter: ["euro", "EUR", "USD", "dollari"],
    symbolAfter: true,
    scaleWords: ["mila", "milioni", "milione", "miliardi", "miliardo", "mln", "mld"],
    countNouns: ["utenti", "clienti", "aziende", "imprese", "siti", "siti web", "persone", "ricerche", "visitatori", "download"],
    multiplierWords: [String.raw`volte\s+(?:più|meno)`],
    timeUnits: {
      hours: ["ore", "ora", "h"],
      minutes: ["minuti", "minuto", "min"],
      seconds: ["secondi", "secondo", "sec"],
      days: ["giorni", "giorno", "gg"],
      weeks: ["settimane", "settimana"],
      months: ["mesi", "mese"],
      years: ["anni", "anno"],
    },
    timeUnitLabels: { hours: "ore", minutes: "minuti", seconds: "secondi", days: "giorni", weeks: "settimane", months: "mesi", years: "anni" },
    perPeriod: String.raw`(?:al|all['’]|a|\/|per)\s*(?:mese|anno|settimana|giorno|utente)(?![\p{L}])`,
    formatPercent: (n) => `${n}%`,
    beforeAfter: new RegExp(
      String.raw`(?<![\p{L}\p{N}])(?<from>da|dal|dall['’])\s*(?<ca>[€$£])?\s?(?<a>\d[\d.,]*)\s?(?<ua>%|€|ore|giorni|settimane|mesi|minuti|secondi)?\s+(?<to>a|al|all['’])\s*(?<cb>[€$£])?\s?(?<b>\d[\d.,]*)\s?(?<ub>%|€|ore|giorni|settimane|mesi|minuti|secondi)?`,
      "iu",
    ),
  },
  prose: {
    attribution: [
      new RegExp(String.raw`(?<![\p{L}])[Ss]econdo\s+(?:(?:il|lo|la|i|gli|le)\s+|l['’])?(${NAME_RUN(4)})`, "u"),
      new RegExp(String.raw`(?<![\p{L}])(?:[Rr]iportat|[Pp]ubblicat|[Cc]ondott|[Rr]ealizzat|[Cc]urat)[oaie]\s+da(?:l|llo|lla|i|gli|lle|ll['’])?\s*(${NAME_RUN(4)})`, "u"),
      new RegExp(String.raw`(?<![\p{L}])(?:[Ss]tudio|[Ii]ndagine|[Rr]apporto|[Rr]icerca|[Aa]nalisi|[Dd]ati|[Ss]ondaggio|[Rr]eport)\s+(?:di|del|dello|della|dei|degli|delle|dell['’])\s*(${NAME_RUN(4)})`, "u"),
      new RegExp(String.raw`(?<![\p{L}\p{N}])(?!(?:Il|Lo|La|I|Gli|Le|Un|Uno|Una|Questo|Questa|Questi)\s)(${NAME_RUN(3)})\s+(?:riporta|stima|rileva|afferma|prevede|segnala|ha rilevato|ha stimato)(?![\p{L}])`, "u"),
    ],
    citableClaim: new RegExp(
      String.raw`\d[^.!?]*?${B}(?:secondo|riporta|riportato|rileva|stima|dati di|studio di|ricerca di|indagine di)${E}|${B}(?:secondo|dati di|studio di|ricerca di|indagine di)${E}[^.!?]*?\d`,
      "iu",
    ),
    evidenceAppeal: new RegExp(
      String.raw`(?<!(?:nostri|nostre|nostro|nostra|vostri|vostre|loro|suoi|sue|miei|mie)\s)${B}(?:studi|ricerche|indagini|sondaggi|dati|analisi|rapporti|uno studio|una ricerca)\s+(?:mostrano|dimostrano|indicano|rivelano|suggeriscono|confermano|mostra|dimostra|indica|rivela|suggerisce|conferma)${E}`,
      "giu",
    ),
    hollowEvidence: new RegExp(
      String.raw`${B}(?:studi|ricerche|indagini|sondaggi|dati|esperti|rapporti)\s+(?:mostrano|dimostrano|indicano|rivelano|suggeriscono|confermano|concordano|consigliano|raccomandano)${E}|${B}è (?:noto|risaputo) che${E}|${B}la maggior parte degli esperti${E}`,
      "giu",
    ),
    superlative: new RegExp(
      String.raw`(?:#1|${B}(?:numero uno|leader (?:di mercato|del settore)|(?:il|la) più grande al mondo|in più rapida crescita)${E})`,
      "giu",
    ),
    announcementOpener:
      /^(in questo (articolo|paragrafo|capitolo|post)|in questa (guida|sezione|parte)|vediamo|prima di (tutto|iniziare)|ora che|quando si parla di|al giorno d['’]oggi|oggigiorno|come (abbiamo visto|sappiamo)|benvenut[oiae])/iu,
    definition: wordsRegex(["è", "sono", "si riferisce a", "significa", "indica", "si intende", "consiste in"]),
    definitionAt: "opening",
    firstHand: wordsRegex([String.raw`abbiamo (?:testato|provato|usato|verificato)`, "nella nostra esperienza", "nei nostri test"]),
    byline: wordsRegex(["scritto da", "autore:", "l['’]autore"]),
    pictureOf:
      /^(?:un['’]?\s*|una\s+|l['’]\s*|la\s+|il\s+)?(?:immagine|foto|fotografia|illustrazione|grafica|schermata|screenshot|diagramma|grafico|infografica|icona|logo)\s+(?:di|che mostra|su|per|del|della|dello|dei|delle)\s+(?:(?:un|una|il|la|lo|i|gli|le)\s+|l['’]\s*)?/iu,
    abbreviations: ["ecc", "es", "pag", "pagg", "sig", "sigg", "dott", "prof", "ca", "n", "nr"],
  },
  headings: {
    faq: /\bfaqs?\b|domande frequenti/iu,
    summary: /(?<![\p{L}])(?:in breve|punti chiave|in sintesi)(?![\p{L}])/iu,
    notIllustrated: /punti chiave|in breve|in sintesi|riepilogo|conclusion[ei]|\bfaqs?\b|domande frequenti|fonti|riferimenti|bibliografia/iu,
    howTo: /^come (?:fare|si|installare|configurare)(?![\p{L}])|(?<![\p{L}])(?:guida passo|passo dopo passo|tutorial)(?![\p{L}])/iu,
    sourcesFooter: ["fonti", "riferimenti", "bibliografia", "fonti e riferimenti", "note e fonti"],
    genericAnchors: ["qui", "clicca qui", "leggi di più", "scopri di più", "questo articolo"],
  },
  voice: {
    firstPersonPlural: wordsRegex(["noi", "nostro", "nostra", "nostri", "nostre"]),
    firstPersonSingular: wordsRegex(["io", "mio", "mia", "miei", "mie"]),
    directAddress: wordsRegex(["tu", "tuo", "tua", "tuoi", "tue", "voi", "vostro", "vostra", "vostri", "vostre"]),
    direct: wordsRegex(["mai", "evita", "evitate", "smetti", "smettete", "non fare"]),
    contractions: null,
  },
};

// ── Spanish ─────────────────────────────────────────────────────────────────

const ES: LocaleRules = {
  code: "es",
  name: "Spanish",
  bcp47: "es",
  wordScale: 1,
  keywordMatch: "word",
  labels: {
    contents: "Índice",
    video: "Vídeo",
    figuresFrom: "Cifras tomadas del texto:",
    barChart: (d) => `Gráfico de barras: ${d}`,
    learnMore: (name) => `Más información sobre ${name}`,
    publishedBy: (name) => `Este artículo es publicado por ${name}.`,
    visit: "Visita {link}.",
    illustration: {
      sketch: "Boceto que ilustra",
      watercolor: "Acuarela que ilustra",
      realistic: "Imagen fotográfica que ilustra",
      illustration: "Ilustración de",
      "brand-text": "Gráfico que ilustra",
    },
    keyTakeaways: "Puntos clave",
    faqHeading: "Preguntas frecuentes",
    before: "Antes",
    after: "Después",
  },
  numbers: {
    decimal: ",",
    group: ".",
    digits: String.raw`\d[\d.,]*`,
    percentSignBefore: false,
    percentWordsAfter: ["por ciento"],
    percentWordsBefore: [],
    currencyAfter: ["euros?", "EUR", "USD", "dólares"],
    symbolAfter: true,
    scaleWords: ["mil", "millones", "millón", "mil millones", "M"],
    countNouns: ["usuarios", "clientes", "empresas", "negocios", "sitios", "sitios web", "personas", "búsquedas", "visitantes", "descargas"],
    multiplierWords: [String.raw`veces\s+(?:más|menos)`],
    timeUnits: {
      hours: ["horas", "hora", "h"],
      minutes: ["minutos", "minuto", "min"],
      seconds: ["segundos", "segundo", "s"],
      days: ["días", "día"],
      weeks: ["semanas", "semana"],
      months: ["meses", "mes"],
      years: ["años", "año"],
    },
    timeUnitLabels: { hours: "horas", minutes: "minutos", seconds: "segundos", days: "días", weeks: "semanas", months: "meses", years: "años" },
    perPeriod: String.raw`(?:al|por|a la|\/)\s*(?:mes|año|semana|día|usuario)(?![\p{L}])`,
    formatPercent: (n) => `${n} %`,
    beforeAfter: new RegExp(
      String.raw`(?<![\p{L}\p{N}])(?<from>de|del)\s+(?<ca>[€$£])?\s?(?<a>\d[\d.,]*)\s?(?<ua>%|€|horas|días|semanas|meses|minutos|segundos)?\s+(?<to>a|al)\s+(?<cb>[€$£])?\s?(?<b>\d[\d.,]*)\s?(?<ub>%|€|horas|días|semanas|meses|minutos|segundos)?`,
      "iu",
    ),
  },
  prose: {
    attribution: [
      new RegExp(String.raw`(?<![\p{L}])[Ss]egún\s+(?:(?:el|la|los|las)\s+)?(${NAME_RUN(4)})`, "u"),
      new RegExp(String.raw`(?<![\p{L}])(?:[Pp]ublicad|[Rr]ealizad|[Ee]laborad|[Rr]eportad)[oa]s?\s+por\s+(?:(?:el|la|los|las)\s+)?(${NAME_RUN(4)})`, "u"),
      new RegExp(String.raw`(?<![\p{L}])(?:[Ee]studio|[Ee]ncuesta|[Ii]nforme|[Ii]nvestigación|[Aa]nálisis|[Dd]atos|[Rr]eporte)\s+(?:de|del)\s+(?:(?:la|los|las)\s+)?(${NAME_RUN(4)})`, "u"),
      new RegExp(String.raw`(?<![\p{L}\p{N}])(?!(?:El|La|Los|Las|Un|Una|Este|Esta|Estos)\s)(${NAME_RUN(3)})\s+(?:informa|estima|revela|afirma|prevé|indica|reporta)(?![\p{L}])`, "u"),
    ],
    citableClaim: new RegExp(
      String.raw`\d[^.!?]*?${B}(?:según|informa|estima|datos de|estudio de|investigación de|encuesta de)${E}|${B}(?:según|datos de|estudio de|investigación de|encuesta de)${E}[^.!?]*?\d`,
      "iu",
    ),
    evidenceAppeal: new RegExp(
      String.raw`(?<!(?:nuestros|nuestras|nuestro|nuestra|sus|mis|tus)\s)${B}(?:estudios|investigaciones|encuestas|datos|análisis|informes|un estudio)\s+(?:muestran|demuestran|indican|revelan|sugieren|confirman|muestra|demuestra|indica|revela|sugiere|confirma)${E}`,
      "giu",
    ),
    hollowEvidence: new RegExp(
      String.raw`${B}(?:estudios|investigaciones|encuestas|datos|expertos|informes)\s+(?:muestran|demuestran|indican|revelan|sugieren|confirman|coinciden|recomiendan)${E}|${B}es bien sabido${E}|${B}la mayoría de los expertos${E}`,
      "giu",
    ),
    superlative: new RegExp(
      String.raw`(?:#1|${B}(?:número uno|líder (?:del mercado|del sector)|(?:el|la) más grande del mundo|de más rápido crecimiento)${E})`,
      "giu",
    ),
    announcementOpener:
      /^(en este (artículo|apartado|post)|en esta (guía|sección)|veamos|antes de (empezar|nada)|ahora que|cuando se trata de|hoy en día|como (ya )?(hemos visto|sabemos)|bienvenid[oa]s?)/iu,
    definition: wordsRegex(["es", "son", "se refiere a", "significa", "consiste en", "se define como"]),
    definitionAt: "opening",
    firstHand: wordsRegex(["hemos probado", "en nuestra experiencia", "en nuestras pruebas"]),
    byline: wordsRegex(["escrito por", "autor:"]),
    pictureOf:
      /^(?:una?\s+|el\s+|la\s+)?(?:imagen|foto|fotografía|ilustración|gráfico|captura de pantalla|diagrama|infografía|icono|logo)\s+(?:de|que muestra|sobre|para|del)\s+(?:(?:un|una|el|la|los|las)\s+)?/iu,
    abbreviations: ["etc", "Sr", "Sra", "Dr", "Dra", "pág", "aprox", "núm", "n"],
  },
  headings: {
    faq: /\bfaqs?\b|preguntas frecuentes/iu,
    summary: /(?<![\p{L}])(?:en resumen|puntos clave)(?![\p{L}])/iu,
    notIllustrated: /puntos clave|en resumen|resumen|conclusi[oó]n|\bfaqs?\b|preguntas frecuentes|fuentes|referencias/iu,
    howTo: /^cómo(?![\p{L}])|(?<![\p{L}])(?:paso a paso|tutorial)(?![\p{L}])/iu,
    sourcesFooter: ["fuentes", "referencias", "fuentes y referencias"],
    genericAnchors: ["aquí", "haz clic aquí", "leer más"],
  },
  voice: {
    firstPersonPlural: wordsRegex(["nosotros", "nosotras", "nuestro", "nuestra", "nuestros", "nuestras"]),
    firstPersonSingular: wordsRegex(["yo", "mío", "mía"]),
    directAddress: wordsRegex(["tú", "tu", "tus", "usted", "ustedes", "vosotros", "vuestro", "vuestra"]),
    direct: wordsRegex(["nunca", "evita", "evite", "deja de", "no hagas"]),
    contractions: null,
  },
};

// ── French ──────────────────────────────────────────────────────────────────

const FR: LocaleRules = {
  code: "fr",
  name: "French",
  bcp47: "fr",
  wordScale: 1,
  keywordMatch: "word",
  labels: {
    contents: "Sommaire",
    video: "Vidéo",
    figuresFrom: "Chiffres tirés du texte :",
    barChart: (d) => `Diagramme en barres : ${d}`,
    learnMore: (name) => `En savoir plus sur ${name}`,
    publishedBy: (name) => `Cet article est publié par ${name}.`,
    visit: "Visitez {link}.",
    illustration: {
      sketch: "Croquis illustrant",
      watercolor: "Aquarelle illustrant",
      realistic: "Image photographique illustrant",
      illustration: "Illustration de",
      "brand-text": "Graphique illustrant",
    },
    keyTakeaways: "L'essentiel",
    faqHeading: "Questions fréquentes",
    before: "Avant",
    after: "Après",
  },
  numbers: {
    decimal: ",",
    group: " ",
    digits: String.raw`\d[\d.,]*`,
    percentSignBefore: false,
    percentWordsAfter: ["pour cent"],
    percentWordsBefore: [],
    currencyAfter: ["euros?", "EUR", "USD", "dollars"],
    symbolAfter: true,
    scaleWords: ["mille", "millions?", "milliards?", "M"],
    countNouns: ["utilisateurs", "clients", "entreprises", "sites", "sites web", "personnes", "recherches", "visiteurs", "téléchargements"],
    multiplierWords: [String.raw`fois\s+(?:plus|moins)`],
    timeUnits: {
      hours: ["heures", "heure", "h"],
      minutes: ["minutes", "minute", "min"],
      seconds: ["secondes", "seconde", "s"],
      days: ["jours", "jour"],
      weeks: ["semaines", "semaine"],
      months: ["mois"],
      years: ["ans", "an", "années", "année"],
    },
    timeUnitLabels: { hours: "heures", minutes: "minutes", seconds: "secondes", days: "jours", weeks: "semaines", months: "mois", years: "ans" },
    perPeriod: String.raw`(?:par|au|\/)\s*(?:mois|an|année|semaine|jour|utilisateur)(?![\p{L}])`,
    formatPercent: (n) => `${n} %`,
    beforeAfter: new RegExp(
      String.raw`(?<![\p{L}\p{N}])(?<from>de)\s+(?<ca>[€$£])?\s?(?<a>\d[\d.,]*)\s?(?<ua>%|€|heures|jours|semaines|mois|minutes|secondes)?\s+(?<to>à)\s+(?<cb>[€$£])?\s?(?<b>\d[\d.,]*)\s?(?<ub>%|€|heures|jours|semaines|mois|minutes|secondes)?`,
      "iu",
    ),
  },
  prose: {
    attribution: [
      new RegExp(String.raw`(?<![\p{L}])(?:[Ss]elon|[Dd]['’]après)\s+(?:(?:le|la|les)\s+|l['’])?(${NAME_RUN(4)})`, "u"),
      new RegExp(String.raw`(?<![\p{L}])(?:[Pp]ublié|[Rr]éalisé|[Mm]ené|[Cc]onduit)e?s?\s+par\s+(?:(?:le|la|les)\s+|l['’])?(${NAME_RUN(4)})`, "u"),
      new RegExp(String.raw`(?<![\p{L}])(?:[ÉéEe]tude|[Ee]nquête|[Rr]apport|[Aa]nalyse|[Dd]onnées|[Ss]ondage)\s+(?:de|du|des|d['’])\s*(?:(?:la)\s+|l['’])?(${NAME_RUN(4)})`, "u"),
      new RegExp(String.raw`(?<![\p{L}\p{N}])(?!(?:Le|La|Les|Un|Une|Ce|Cette|Ces)\s)(${NAME_RUN(3)})\s+(?:rapporte|estime|révèle|affirme|prévoit|indique)(?![\p{L}])`, "u"),
    ],
    citableClaim: new RegExp(
      String.raw`\d[^.!?]*?${B}(?:selon|d['’]après|rapporte|estime|données de|étude de|enquête de)${E}|${B}(?:selon|d['’]après|données de|étude de|enquête de)${E}[^.!?]*?\d`,
      "iu",
    ),
    evidenceAppeal: new RegExp(
      String.raw`(?<!(?:nos|notre|vos|votre|leurs|leur|mes|ses)\s)${B}(?:études|recherches|enquêtes|données|analyses|rapports|une étude)\s+(?:montrent|démontrent|indiquent|révèlent|suggèrent|confirment|montre|démontre|indique|révèle|suggère|confirme)${E}`,
      "giu",
    ),
    hollowEvidence: new RegExp(
      String.raw`${B}(?:études|recherches|enquêtes|données|experts|rapports)\s+(?:montrent|démontrent|indiquent|révèlent|suggèrent|confirment|recommandent|s['’]accordent)${E}|${B}il est bien connu${E}|${B}la plupart des experts${E}`,
      "giu",
    ),
    superlative: new RegExp(
      String.raw`(?:#1|${B}(?:numéro un|leader (?:du marché|du secteur)|(?:le|la) plus grand(?:e)? au monde|à la croissance la plus rapide)${E})`,
      "giu",
    ),
    announcementOpener:
      /^(dans cet (article|guide)|dans cette (section|partie)|voyons|avant de (commencer|plonger)|maintenant que|lorsqu['’]il s['’]agit de|aujourd['’]hui|de nos jours|comme nous l['’]avons vu|bienvenue)/iu,
    definition: wordsRegex(["est", "sont", "désigne", "signifie", "correspond à", "se définit comme", "consiste à"]),
    definitionAt: "opening",
    firstHand: wordsRegex([String.raw`nous avons (?:testé|essayé)`, "d['’]après notre expérience", "lors de nos tests"]),
    byline: wordsRegex(["écrit par", "auteur :", "auteur:"]),
    pictureOf:
      /^(?:une?\s+|l['’]\s*|la\s+|le\s+)?(?:image|photo|photographie|illustration|graphique|capture d['’]écran|diagramme|infographie|icône|logo)\s+(?:de|montrant|sur|pour|du|des|d['’])\s*(?:(?:un|une|le|la|les)\s+|l['’]\s*)?/iu,
    abbreviations: ["etc", "M", "Mme", "Mlle", "p", "cf", "env", "n°", "no"],
  },
  headings: {
    faq: /\bfaqs?\b|questions fr[ée]quentes/iu,
    summary: /(?<![\p{L}])(?:en r[ée]sum[ée]|l['’]essentiel)(?![\p{L}])/iu,
    notIllustrated: /l['’]essentiel|en r[ée]sum[ée]|conclusion|\bfaqs?\b|questions fr[ée]quentes|sources|références/iu,
    howTo: /^comment(?![\p{L}])|(?<![\p{L}])(?:étape par étape|tutoriel)(?![\p{L}])/iu,
    sourcesFooter: ["références", "sources et références", "sources", "bibliographie"],
    genericAnchors: ["ici", "cliquez ici", "en savoir plus"],
  },
  voice: {
    firstPersonPlural: wordsRegex(["nous", "notre", "nos"]),
    firstPersonSingular: new RegExp(String.raw`${B}(?:je|moi|mon|ma|mes)${E}|${B}j['’]`, "iu"),
    directAddress: wordsRegex(["vous", "votre", "vos", "tu", "ton", "ta", "tes"]),
    direct: wordsRegex(["jamais", "évitez", "évite", "arrêtez", "ne faites pas"]),
    contractions: null,
  },
};

// ── German ──────────────────────────────────────────────────────────────────
//
// German capitalises every noun, so "a capitalised word" is not "a name"
// here: the markers name the article and the generic nouns a source is not.

const DE_NOT_A_NAME = String.raw`(?!(?:Der|Die|Das|Den|Dem|Des|Ein|Eine|Einer|Einem|Diese|Dieser|Dieses|Studie|Studien|Umfrage|Bericht|Analyse|Daten|Angaben|Statistik|Experten|Schätzungen)(?![\p{L}]))`;

const DE: LocaleRules = {
  code: "de",
  name: "German",
  bcp47: "de",
  wordScale: 1,
  keywordMatch: "word",
  labels: {
    contents: "Inhalt",
    video: "Video",
    figuresFrom: "Zahlen aus dem Text:",
    barChart: (d) => `Balkendiagramm: ${d}`,
    learnMore: (name) => `Mehr über ${name}`,
    publishedBy: (name) => `Dieser Artikel wird von ${name} veröffentlicht.`,
    visit: "Besuchen Sie {link}.",
    illustration: {
      sketch: "Skizze zu",
      watercolor: "Aquarell zu",
      realistic: "Fotografische Darstellung von",
      illustration: "Illustration zu",
      "brand-text": "Grafik zu",
    },
    keyTakeaways: "Das Wichtigste",
    faqHeading: "Häufig gestellte Fragen",
    before: "Vorher",
    after: "Nachher",
  },
  numbers: {
    decimal: ",",
    group: ".",
    digits: String.raw`\d[\d.,]*`,
    percentSignBefore: false,
    percentWordsAfter: ["prozent"],
    percentWordsBefore: [],
    currencyAfter: ["Euro", "EUR", "USD", "Dollar"],
    symbolAfter: true,
    scaleWords: ["Tausend", "Millionen", "Million", "Milliarden", "Milliarde", String.raw`Mio\.?`, String.raw`Mrd\.?`],
    countNouns: ["Nutzer", "Nutzerinnen", "Kunden", "Unternehmen", "Firmen", "Websites", "Webseiten", "Menschen", "Personen", "Suchanfragen", "Besucher", "Downloads"],
    multiplierWords: [String.raw`(?:-mal|\s?mal)\s+(?:mehr|weniger|schneller|langsamer|höher|niedriger|besser|schlechter)`],
    timeUnits: {
      hours: ["Stunden", "Stunde", "Std\\.?", "h"],
      minutes: ["Minuten", "Minute", "Min\\.?"],
      seconds: ["Sekunden", "Sekunde", "Sek\\.?"],
      days: ["Tage", "Tagen", "Tag"],
      weeks: ["Wochen", "Woche"],
      months: ["Monate", "Monaten", "Monat"],
      years: ["Jahre", "Jahren", "Jahr"],
    },
    timeUnitLabels: { hours: "Stunden", minutes: "Minuten", seconds: "Sekunden", days: "Tage", weeks: "Wochen", months: "Monate", years: "Jahre" },
    perPeriod: String.raw`(?:pro|im|je|\/)\s*(?:Monat|Jahr|Woche|Tag|Nutzer)(?![\p{L}])`,
    formatPercent: (n) => `${n} %`,
    beforeAfter: new RegExp(
      String.raw`(?<![\p{L}\p{N}])(?<from>von)\s+(?<ca>[€$£])?\s?(?<a>\d[\d.,]*)\s?(?<ua>%|€|Prozent|Stunden|Tagen|Tage|Wochen|Monaten|Monate|Minuten|Sekunden)?\s+(?<to>auf|bis)\s+(?<cb>[€$£])?\s?(?<b>\d[\d.,]*)\s?(?<ub>%|€|Prozent|Stunden|Tagen|Tage|Wochen|Monaten|Monate|Minuten|Sekunden)?`,
      "iu",
    ),
  },
  prose: {
    attribution: [
      new RegExp(String.raw`(?<![\p{L}])[Ll]aut\s+(?:(?:der|dem|des|einer|einem)\s+)?(?:(?:Studie|Umfrage|Bericht|Analyse|Daten|Angaben|Statistik)\s+(?:von|vom|der|des)\s+)?${DE_NOT_A_NAME}(${NAME_RUN(4)})`, "u"),
      new RegExp(String.raw`(?<![\p{L}])(?:[Vv]eröffentlicht|[Dd]urchgeführt|[Ee]rhoben|[Ee]rstellt)\s+(?:von|vom)\s+(?:(?:der|dem)\s+)?${DE_NOT_A_NAME}(${NAME_RUN(4)})`, "u"),
      new RegExp(String.raw`(?<![\p{L}])(?:Studie|Umfrage|Bericht|Analyse|Daten|Erhebung|Statistik)\s+(?:von|vom|der|des)\s+(?:(?:der|dem)\s+)?${DE_NOT_A_NAME}(${NAME_RUN(4)})`, "u"),
      new RegExp(String.raw`(?<![\p{L}\p{N}])${DE_NOT_A_NAME}(${NAME_RUN(3)})\s+(?:berichtet|schätzt|meldet|prognostiziert|zufolge)(?![\p{L}])`, "u"),
    ],
    citableClaim: new RegExp(
      String.raw`\d[^.!?]*?${B}(?:laut|zufolge|berichtet|schätzt|daten von|studie von|umfrage von)${E}|${B}(?:laut|daten von|studie von|umfrage von)${E}[^.!?]*?\d`,
      "iu",
    ),
    evidenceAppeal: new RegExp(
      String.raw`(?<!(?:unsere|unserer|unseren|ihre|seine|meine|eure)\s)${B}(?:Studien|Untersuchungen|Umfragen|Daten|Analysen|Berichte|Forschung|eine Studie)\s+(?:zeigen|belegen|beweisen|bestätigen|legen nahe|zeigt|belegt|beweist|bestätigt)${E}`,
      "giu",
    ),
    hollowEvidence: new RegExp(
      String.raw`${B}(?:Studien|Untersuchungen|Umfragen|Daten|Experten|Berichte|Forschung)\s+(?:zeigen|belegen|beweisen|bestätigen|empfehlen|legen nahe)${E}|${B}bekanntlich${E}|${B}die meisten Experten${E}`,
      "giu",
    ),
    superlative: new RegExp(
      String.raw`(?:#1|${B}(?:Nummer eins|Marktführer|Branchenführer|weltweit größte[rsn]?|am schnellsten wachsende[rsn]?)${E})`,
      "giu",
    ),
    announcementOpener:
      /^(in diesem (artikel|abschnitt|beitrag|leitfaden)|lassen sie uns|schauen wir|bevor wir|nachdem wir|wenn es um|heutzutage|in der heutigen|wie (wir|bereits) (gesehen|erwähnt)|willkommen)/iu,
    definition: wordsRegex(["ist", "sind", "bezeichnet", "bedeutet", "versteht man", "beschreibt"]),
    definitionAt: "opening",
    firstHand: wordsRegex([String.raw`wir haben (?:getestet|ausprobiert)`, String.raw`wir haben \p{L}+ (?:getestet|ausprobiert)`, "nach unserer erfahrung", "in unseren tests"]),
    byline: wordsRegex(["verfasst von", "geschrieben von", "autor:", "autorin:"]),
    pictureOf:
      /^(?:ein(?:e)?\s+|das\s+|die\s+|der\s+)?(?:bild|foto|fotografie|illustration|grafik|screenshot|bildschirmfoto|diagramm|infografik|icon|logo)\s+(?:von|zu|über|für|mit)\s+(?:(?:einem|einer|einen|dem|der|den|das|die)\s+)?/iu,
    abbreviations: ["bzw", "usw", "ca", "Nr", "Dr", "Prof", "ggf", "inkl", "vgl", "evtl", "Abb", "Tab"],
  },
  headings: {
    faq: /\bfaqs?\b|h[äa]ufig gestellte/iu,
    summary: /(?<![\p{L}])(?:kurz gesagt|das wichtigste|zusammenfassung)(?![\p{L}])/iu,
    notIllustrated: /das wichtigste|kurz gesagt|zusammenfassung|fazit|\bfaqs?\b|h[äa]ufig gestellte|quellen|literatur/iu,
    howTo: /^wie (?:man|du|sie)(?![\p{L}])|(?<![\p{L}])(?:schritt für schritt|anleitung|tutorial)(?![\p{L}])/iu,
    sourcesFooter: ["quellen", "literatur", "quellenverzeichnis", "literaturverzeichnis", "quellen und literatur"],
    genericAnchors: ["hier", "hier klicken", "mehr erfahren"],
  },
  voice: {
    firstPersonPlural: wordsRegex(["wir", "unser", "unsere", "unseren", "unserem", "unserer", "uns"]),
    firstPersonSingular: wordsRegex(["ich", "mein", "meine", "mich", "mir"]),
    // Formal "Sie" is also "they" and "she"; only its possessive forms are unambiguous enough.
    directAddress: new RegExp(String.raw`${B}(?:[Dd]u|[Dd]ein|[Dd]eine|[Dd]ich|[Dd]ir|[Ee]uch|[Ee]uer|[Ee]ure|Ihnen|Ihr|Ihre|Ihren|Ihrem)${E}`, "u"),
    direct: wordsRegex(["nie", "niemals", "vermeiden sie", "vermeide", "hören sie auf"]),
    contractions: null,
  },
};

// ── Turkish ─────────────────────────────────────────────────────────────────
//
// Turkish is agglutinative and verb-final, which is what the English rules
// got wrong about it:
//
//   - Suffixes carry what English writes as separate words: "sitelerimizden"
//     is "from our sites". The first-person plural the voice analyser missed
//     is usually a suffix (-iz on verbs, -imiz on nouns), not the word "biz".
//   - A keyword appears with suffixes on it: "web tasarımı", "web
//     tasarımında". Whole-word matching counted none of them.
//   - A proper noun takes its case suffix after an apostrophe: "Gartner'a
//     göre" is "according to Gartner", with the postposition after the name.
//   - Percentages are written "%20" and "yüzde 20"; decimals take a comma and
//     thousands a dot: "₺1.500,50", "1.500,50 TL".
//   - The copula is a suffix at the end of the sentence ("...bir yöntemdir"),
//     so a definition's verb is where the sentence ends, not where it starts.
//   - The same content runs to about a fifth fewer words than in English.
//     `wordScale` 0.8 scales every word-count band by that.
//
// Lowercasing uses the Turkish rules (İ -> i, I -> ı), so every lowered
// pattern below is written in lowercase with ı and i as Turkish spells them.

const TR_NAME = String.raw`\p{Lu}[\p{L}\p{N}&.-]*(?:\s+\p{Lu}[\p{L}\p{N}&.-]*){0,4}`;
const TR_CASE = String.raw`(?:['’]\p{Ll}{1,5})?`;
const TR_SOURCE_NOUN = "(?:raporu|araştırması|çalışması|anketi|verileri|analizi|istatistikleri|tahmini|tahminleri|açıklaması)";

const TR: LocaleRules = {
  code: "tr",
  name: "Turkish",
  bcp47: "tr",
  wordScale: 0.8,
  keywordMatch: "stem",
  labels: {
    contents: "İçindekiler",
    video: "Video",
    figuresFrom: "Metindeki rakamlar:",
    barChart: (d) => `Çubuk grafik: ${d}`,
    learnMore: (name) => `${name} hakkında daha fazla bilgi`,
    publishedBy: (name) => `Bu makale ${name} tarafından yayımlanmıştır.`,
    visit: "{link} adresini ziyaret edin.",
    illustration: {
      sketch: "Eskiz çizim:",
      watercolor: "Suluboya resim:",
      realistic: "Fotoğraf tarzı görsel:",
      illustration: "İllüstrasyon:",
      "brand-text": "Grafik:",
    },
    keyTakeaways: "Öne çıkan noktalar",
    faqHeading: "Sıkça sorulan sorular",
    before: "Önce",
    after: "Sonra",
  },
  numbers: {
    decimal: ",",
    group: ".",
    digits: String.raw`\d[\d.,]*`,
    percentSignBefore: true,
    percentWordsAfter: [],
    percentWordsBefore: ["yüzde"],
    currencyAfter: ["TL", "TRY", "lira", "USD", "EUR", "dolar", "avro", "euro"],
    symbolAfter: true,
    scaleWords: ["bin", "milyon", "milyar", "trilyon"],
    countNouns: ["kullanıcı", "müşteri", "şirket", "işletme", "web sitesi", "site", "kişi", "insan", "arama", "ziyaretçi", "indirme"],
    // "3 kat daha hızlı", "3 katına çıktı", and the bare "3 kat arttı".
    multiplierWords: [String.raw`kat\s+daha`, "katına", "katı", "misli", "kat"],
    timeUnits: {
      hours: ["saat", "sa"],
      minutes: ["dakika", "dk"],
      seconds: ["saniye", "sn"],
      days: ["gün"],
      weeks: ["hafta"],
      months: ["ay"],
      years: ["yıl"],
    },
    timeUnitLabels: { hours: "saat", minutes: "dakika", seconds: "saniye", days: "gün", weeks: "hafta", months: "ay", years: "yıl" },
    perPeriod: String.raw`(?:\/\s*(?:ay|yıl|hafta|gün|kullanıcı)|(?:aylık|yıllık|haftalık|günlük))(?![\p{L}])`,
    formatPercent: (n) => `%${n}`,
    // "%42'den %61'e", "120 TL'den 90 TL'ye", "12 saatten 3 saate". The
    // direction is in the suffixes, so the bars take the labels above.
    beforeAfter: new RegExp(
      String.raw`(?<![\p{L}\p{N}])(?<ca>[€$£₺%])?\s?(?<a>\d[\d.,]*)\s?(?<ua>TL|₺|%|saat|gün|hafta|ay|dakika|saniye)?['’]?(?:den|dan|ten|tan)\s+(?<cb>[€$£₺%])?\s?(?<b>\d[\d.,]*)\s?(?<ub>TL|₺|%|saat|gün|hafta|ay|dakika|saniye)?['’]?(?:ye|ya|e|a)(?![\p{L}])`,
      "u",
    ),
  },
  prose: {
    attribution: [
      // "Gartner'a göre", "TÜİK'e göre": a proper noun, its case suffix
      // after the apostrophe, then the postposition. Requiring the
      // apostrophe keeps "Buna göre" (accordingly) from reading as a source.
      new RegExp(String.raw`(?<![\p{L}\p{N}])(${TR_NAME})['’]\p{Ll}{1,4}\s+göre(?![\p{L}])`, "u"),
      // "Dünya Bankası verilerine göre", "McKinsey'nin 2025 raporuna göre".
      new RegExp(String.raw`(?<![\p{L}\p{N}])(${TR_NAME})${TR_CASE}\s+(?:\d{4}\s+)?(?:yılı\s+)?${TR_SOURCE_NOUN}n?[ae]\s+göre(?![\p{L}])`, "u"),
      // "Gartner tarafından yayımlanan".
      new RegExp(String.raw`(?<![\p{L}\p{N}])(${TR_NAME})${TR_CASE}\s+tarafından(?![\p{L}])`, "u"),
      // "Statista'nın verileri", "HubSpot'un araştırması".
      new RegExp(String.raw`(?<![\p{L}\p{N}])(${TR_NAME})['’]n?[ıiuü]n\s+(?:\d{4}\s+)?(?:yılı\s+)?${TR_SOURCE_NOUN}(?![\p{L}])`, "u"),
      // "TÜİK açıkladı", "Gartner'ın yayımladığı".
      new RegExp(String.raw`(?<![\p{L}\p{N}])(${TR_NAME})${TR_CASE}\s+(?:açıkladı|bildirdi|raporladı|tahmin ediyor|öngörüyor|açıkladığı|bildirdiği|yayımladığı|yayınladığı)(?![\p{L}])`, "u"),
    ],
    citableClaim: new RegExp(
      String.raw`\d[^!?]*?(?:göre|tarafından|açıkladı|bildirdi|tahmin)(?![\p{L}])|${B}(?:göre|tarafından)${E}[^!?]*?\d`,
      "iu",
    ),
    evidenceAppeal: new RegExp(
      String.raw`${B}(?:araştırmalar|çalışmalar|anketler|raporlar|veriler|analizler|araştırma|çalışma|anket|rapor)\s+(?:gösteriyor|göstermektedir|ortaya koyuyor|ortaya koymaktadır|kanıtlıyor|doğruluyor|işaret ediyor)${E}|${B}(?:araştırmalara|çalışmalara|verilere|anketlere)\s+göre${E}`,
      "giu",
    ),
    hollowEvidence: new RegExp(
      String.raw`${B}(?:araştırmalar|çalışmalar|anketler|raporlar|veriler|uzmanlar)\s+(?:gösteriyor|göstermektedir|ortaya koyuyor|öneriyor|kanıtlıyor|doğruluyor|hemfikir)${E}|${B}(?:araştırmalara|çalışmalara|verilere|uzmanlara)\s+göre${E}|${B}bilindiği (?:gibi|üzere)${E}|${B}uzmanların çoğu${E}`,
      "giu",
    ),
    superlative: new RegExp(
      String.raw`(?:#1|${B}(?:bir numaralı|(?:dünyanın|türkiye['’]nin) en (?:büyük|popüler|iyi|hızlı)|sektör(?:ün)? lideri|pazar lideri|en hızlı büyüyen)${E})`,
      "giu",
    ),
    announcementOpener:
      /^(bu (bölümde|yazıda|makalede|rehberde|içerikte)|şimdi|öncelikle|hadi|gelin|günümüzde|bilindiği gibi|daha önce (de )?belirttiğimiz gibi|merak ediyor olabilirsiniz|hoş geldiniz)/u,
    // The copula suffix (-dır, -dir, -dur, -dür, -tır...) on the last word,
    // or a defining phrase. Tested on the first sentence's end.
    definition: new RegExp(
      String.raw`(?:\p{L}(?:dır|dir|dur|dür|tır|tir|tur|tür)|anlamına gelir|demektir|olarak tanımlanır|olarak adlandırılır|ifade eder|denir)[.!]?$`,
      "u",
    ),
    definitionAt: "firstSentenceEnd",
    firstHand: new RegExp(
      String.raw`${B}(?:test ettik|denedik|deneyimlerimize göre|deneyimimize göre|kendi testlerimizde|testlerimizde|kullandığımızda|ekibimiz (?:test etti|denedi|kullandı))${E}`,
      "u",
    ),
    byline: new RegExp(String.raw`${B}(?:yazar:|yazan:|tarafından yazıldı|yazarı:)`, "u"),
    // Turkish puts the head noun last: "web tasarımı görseli" is "an image of
    // web design". So the wrapper is stripped from the end as well as the start.
    pictureOf:
      /^(?:bir\s+)?(?:görsel|resim|fotoğraf|illüstrasyon|grafik|ekran görüntüsü|diyagram|şema|infografik|ikon|logo)\s*:?\s+|\s+(?:görseli|resmi|fotoğrafı|illüstrasyonu|grafiği|ekran görüntüsü|diyagramı|şeması|infografiği|ikonu|logosu)$/u,
    abbreviations: ["vb", "vs", "Dr", "Prof", "Doç", "örn", "yak", "Av", "Sn", "Ltd", "Şti", "No"],
  },
  headings: {
    faq: /\bfaqs?\b|(?<![\p{L}])sss(?![\p{L}])|sık(?:ça)? sorulan sorular/u,
    summary: /(?<![\p{L}])(?:öne çıkan noktalar|önemli noktalar|temel çıkarımlar|kısaca|özetle|özet)(?![\p{L}])/u,
    notIllustrated: /öne çıkan noktalar|önemli noktalar|temel çıkarımlar|kısaca|özetle|özet|sonuç|sık(?:ça)? sorulan sorular|(?<![\p{L}])sss(?![\p{L}])|kaynaklar|kaynakça|referanslar/u,
    howTo: /(?:^|\s)(?:nasıl|adım adım)(?![\p{L}])|kurulum|rehberi?(?![\p{L}])/u,
    sourcesFooter: ["kaynaklar", "kaynakça", "referanslar", "kaynaklar ve referanslar", "ileri okuma", "ek okumalar"],
    genericAnchors: ["burada", "buraya", "buraya tıklayın", "buraya tıkla", "tıklayın", "tıkla", "devamını oku", "devamı", "daha fazla", "daha fazlası", "bu makale", "bu yazı", "bağlantı", "link", "incele"],
  },
  voice: {
    // "biz", "bizim", "bize", and the suffixes: -imiz on nouns ("ekibimiz",
    // our team), -iz after the tense on verbs ("sunuyoruz", "yaparız").
    firstPersonPlural: new RegExp(
      String.raw`${B}(?:biz|bizim|bize|bizi|bizden|bizde|bizce)${E}|\p{L}{2,}(?:ımız|imiz|umuz|ümüz|ımıza|imize|umuza|ümüze|ımızı|imizi|umuzu|ümüzü|ımızda|imizde|umuzda|ümüzde)${E}|\p{L}{2,}(?:yoruz|ıyoruz|iyoruz|uyoruz|üyoruz|arız|eriz|ırız|iriz|uruz|ürüz|acağız|eceğiz|mekteyiz|maktayız)${E}`,
      "iu",
    ),
    // Pronouns only: the singular suffix -ım is also the end of ordinary
    // nouns ("tasarım"), and reading it as "my" would be a guess.
    firstPersonSingular: new RegExp(String.raw`${B}(?:ben|benim|bana|beni|benden|bende)${E}`, "iu"),
    directAddress: new RegExp(
      String.raw`${B}(?:siz|sizin|size|sizi|sizden|sen|senin|sana|seni)${E}|\p{L}{3,}(?:ınız|iniz|unuz|ünüz|nız|niz|nuz|nüz)${E}`,
      "iu",
    ),
    direct: new RegExp(String.raw`${B}(?:asla|sakın|kaçının)${E}|\p{L}{2,}(?:mayın|meyin)${E}`, "iu"),
    contractions: null,
  },
};

const RULES: Record<SupportedLanguage, LocaleRules> = { en: EN, it: IT, es: ES, fr: FR, de: DE, tr: TR };

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * The primary language subtag of whatever was stored: a code ("tr",
 * "pt-pt", "zh-CN") or, from older rows and the wizard, a label ("Turkish",
 * "English (UK)"). Empty means the column default.
 */
function primaryCode(language: string | null | undefined): string {
  const raw = (language ?? "").trim();
  if (!raw) return "en";
  const lowered = raw.toLowerCase();
  const byLabel = Object.values(LOCALES).find((e) => e.label.toLowerCase() === lowered);
  const code = byLabel ? byLabel.languageCode : lowered;
  return code.split(/[-_]/)[0].toLowerCase();
}

function nameOf(code: string): string {
  const entry = LOCALES[code];
  if (entry) return entry.label.replace(/\s*\(.*\)$/, "");
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function lowerFor(bcp47: string): (text: string) => string {
  return (text) => {
    try {
      return text.toLocaleLowerCase(bcp47);
    } catch {
      return text.toLowerCase();
    }
  };
}

const RESOLVED = new Map<string, Locale>();

/**
 * The rules for a stored language, or an explicit "unsupported".
 *
 * `"tr"`, `"Turkish"` and `"tr-TR"` resolve alike; `"en-gb"` is English. An
 * empty value is English, the column default (see the header).
 */
export function resolveLocale(language: string | null | undefined): Locale {
  const code = primaryCode(language);
  const cached = RESOLVED.get(code);
  if (cached) return cached;
  let locale: Locale;
  if ((SUPPORTED_LANGUAGES as readonly string[]).includes(code)) {
    const rules = RULES[code as SupportedLanguage];
    locale = { ...rules, supported: true, lower: lowerFor(rules.bcp47) };
  } else {
    locale = { supported: false, code, name: nameOf(code), bcp47: code, lower: lowerFor(code) };
  }
  RESOLVED.set(code, locale);
  return locale;
}

/** Every supported language's rules, for detectors that recognise labels in any of them. */
export function supportedLocales(): SupportedLocale[] {
  return SUPPORTED_LANGUAGES.map((code) => resolveLocale(code) as SupportedLocale);
}

const SUPPORTED_NAMES = SUPPORTED_LANGUAGES.map((c) => RULES[c].name);

/** "English, Italian, Spanish, French, German and Turkish". */
export const SUPPORTED_LANGUAGE_LIST = `${SUPPORTED_NAMES.slice(0, -1).join(", ")} and ${SUPPORTED_NAMES[SUPPORTED_NAMES.length - 1]}`;

/**
 * What a check says when it could not run on this language. One sentence,
 * the same everywhere, so a reviewer learns it once.
 */
export function notCheckedFor(locale: Locale): string {
  return `Not checked for ${locale.name}: this check reads ${SUPPORTED_LANGUAGE_LIST} only.`;
}

// ── Recognising labels in any supported language ───────────────────────────

/**
 * Whether `text` matches the heading rule `field` in any supported language.
 * Lowered per language first, so "SIKÇA SORULAN SORULAR" and "İçindekiler"
 * match the lowercase Turkish patterns.
 */
export function matchesAnyHeading(field: "faq" | "summary" | "notIllustrated" | "howTo", text: string): boolean {
  return supportedLocales().some((l) => l.headings[field].test(l.lower(text)));
}

/** The union of a label list across every supported language, folded with `foldCase`: compare a folded string. */
export function anyLanguageLabels(field: "sourcesFooter" | "genericAnchors"): Set<string> {
  return new Set(supportedLocales().flatMap((l) => l.headings[field].map(foldCase)));
}

// ── Matching a keyword or a label ───────────────────────────────────────────
//
// Two lowercasings, for two jobs. `Locale.lower` is the language's own, and
// prose rules are written against it: in Turkish the dotless ı is a
// different letter ("kır" is countryside, "kir" is dirt), so a pattern must
// see it. But a keyword is matched, not read, and there the Turkish rule
// hurts: it lowers "API" to "apı", "AI" to "aı" and "UI" to "uı", so the
// keyword "api entegrasyonu" was missing from an article whose H1 said "API
// Entegrasyonu", and its density read 0%. English casing, before this
// contract, matched it. The acronyms are written the English way in every
// language, and a web agency writes them in every heading.
//
// `foldCase` makes the four I's one letter (I, İ, ı, i), on both sides, and
// is otherwise plain lowercase. It is the same in every language, so a label
// written in one language's casing is found by any other's.

/** Lowercase for matching a keyword or a label: case and the Turkish I variants do not count. Not for prose rules. */
export function foldCase(text: string): string {
  return text.toLowerCase().replace(/\u0307/g, "").replace(/ı/g, "i");
}

// ── Words, stems and scales ─────────────────────────────────────────────────

/**
 * What may follow a word before its boundary: nothing in a language that
 * writes grammar as separate words, any run of letters in one that writes it
 * as suffixes ("liraya", "kullanıcıya"). A regex fragment.
 */
export function inflection(locale: SupportedLocale): string {
  return locale.keywordMatch === "stem" ? String.raw`\p{L}*` : "";
}

/** A word-count threshold set for English, in this language's words. */
export function scaleWords(englishWords: number, locale: SupportedLocale): number {
  return Math.max(1, Math.round(englishWords * locale.wordScale));
}

/**
 * Every occurrence of `keyword` in `text`, by this language's rule: whole
 * words, or a stem that suffixes may follow. Both sides are folded with
 * `foldCase`, and the boundaries are Unicode, so "città" and "ölçüm" are
 * found where `\b` found nothing.
 */
export function countKeyword(text: string, keyword: string, locale: SupportedLocale): number {
  const kw = foldCase(keyword.trim());
  if (!kw) return 0;
  const body = escapeRegex(kw).replace(/\s+/g, String.raw`\s+`);
  const re = new RegExp(`${B}${body}${locale.keywordMatch === "word" ? E : ""}`, "gu");
  return (foldCase(text).match(re) ?? []).length;
}

/** Whether `text` contains the keyword, by the same rule as `countKeyword`. */
export function containsKeyword(text: string, keyword: string, locale: Locale): boolean {
  if (!locale.supported) return foldCase(text).includes(foldCase(keyword.trim()));
  return countKeyword(text, keyword, locale) > 0;
}

/**
 * Fragments of `text` matching `re` after lowering, returned as written in
 * `text` so a reviewer's "jump to" finds them. Lowering is length-preserving
 * for every supported language except English "İ"; when it is not, the
 * raw text is searched instead.
 */
export function findLowered(re: RegExp, text: string, locale: Locale): string[] {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const global = new RegExp(re.source, flags);
  const lowered = locale.lower(text);
  if (lowered.length !== text.length) return [...text.matchAll(global)].map((m) => m[0]);
  return [...lowered.matchAll(global)].map((m) => text.slice(m.index ?? 0, (m.index ?? 0) + m[0].length));
}

// ── Numbers ─────────────────────────────────────────────────────────────────

/**
 * A number as this language writes it, or null when it cannot be read with
 * certainty. "1.500,50" is 1500.5 in Turkish and nonsense in English; a
 * group separator must be followed by exactly three digits.
 */
export function parseNumber(raw: string, locale: SupportedLocale): number | null {
  const { decimal, group } = locale.numbers;
  let s = raw.trim().replace(/[  ]/g, " ");
  if (group === " ") s = s.replace(/(\d) (?=\d{3}(?!\d))/g, "$1");
  const groupRe = new RegExp(`${escapeRegex(group)}(?=\\d{3}(?:\\D|$))`, "g");
  s = s.replace(groupRe, "");
  const parts = s.split(decimal);
  if (parts.length > 2) return null;
  // Whatever separator is left is the other language's: ambiguous, refuse.
  if (/[.,\s]/.test(parts[0]) || (parts[1] !== undefined && /[.,\s]/.test(parts[1]))) return null;
  const n = parseFloat(parts.join("."));
  return Number.isFinite(n) ? n : null;
}

/** A number as this language prints it, at most one decimal. */
export function formatNumber(value: number, locale: SupportedLocale): string {
  return new Intl.NumberFormat(locale.bcp47, { maximumFractionDigits: 1, useGrouping: false }).format(value);
}

// ── Slugs and anchors ───────────────────────────────────────────────────────
//
// Language-independent on purpose: an anchor id and the URL slug are made by
// callers that do not all know the language (the git publisher, the agent
// API), and an anchor that depends on who made it is a TOC that points at
// nothing. The fold covers the letters NFKD does not decompose - Turkish ı,
// German ß, Nordic ø and æ, Polish ł - and gives each its one conventional
// ASCII form. Turkish's six (ı ş ğ ç ö ü, and İ) fold to i s g c o u i, which
// is how Turkish sites write their own URLs.

const FOLD: Record<string, string> = {
  ı: "i", ß: "ss", ø: "o", Ø: "o", æ: "ae", Æ: "ae", œ: "oe", Œ: "oe",
  ł: "l", Ł: "l", đ: "d", Đ: "d", ð: "d", Ð: "d", þ: "th", Þ: "th", ħ: "h", Ħ: "h",
};
const FOLD_RE = new RegExp(`[${Object.keys(FOLD).join("")}]`, "g");

/** Lowercase ASCII letters, digits and single hyphens. */
export function foldToAscii(text: string): string {
  return text
    .replace(FOLD_RE, (c) => FOLD[c])
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/** The URL slug for a title or keyword. */
export function urlSlug(text: string): string {
  return foldToAscii(text);
}

/**
 * A heading as a portable anchor id: ASCII, hyphens, at most `maxLength`,
 * starting with a letter so it is a valid CSS selector ("5 ways" -> "s-5-ways").
 */
export function anchorId(text: string, maxLength = 64): string {
  const base = foldToAscii(text).slice(0, maxLength).replace(/-$/, "");
  if (!base) return "section";
  return /^[a-z]/.test(base) ? base : `s-${base}`;
}
