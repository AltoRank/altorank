// ---------------------------------------------------------------------------
// What shape of article a keyword wants
// ---------------------------------------------------------------------------
//
// A keyword implies a format before anyone writes a word: "how to X" is a
// walkthrough, "best X" is a ranked list, "X vs Y" is a comparison. The
// planner shows the shape on every card so the person reviewing the month can
// see at a glance that it is not thirty explainers in a row, and the writer is
// told the shape so it does not have to infer it from the term.
//
// Rules, not a model. The classification has to be free, instant and the same
// every time the card renders, and the person can override it anyway.

import type { KeywordIntent } from "@/lib/types";

export type ArticleType = "guide" | "listicle";
export type ArticleSubtype =
  | "howTo"
  | "explainer"
  | "comparison"
  | "reference"
  | "roundup"
  | "resources"
  | "examples";

export interface KeywordTaxonomy {
  article_type: ArticleType;
  article_subtype: ArticleSubtype;
}

/** Labels match the badge convention users know from other planners. */
export const TAXONOMY_LABELS: Record<ArticleSubtype, string> = {
  howTo: "Guide: How-to",
  explainer: "Guide: Explainer",
  comparison: "Guide: Comparison",
  reference: "Guide: Reference",
  roundup: "List: Round-up",
  resources: "List: Resources",
  examples: "List: Examples",
};

export function taxonomyLabel(subtype: string | null | undefined): string | null {
  return subtype && subtype in TAXONOMY_LABELS ? TAXONOMY_LABELS[subtype as ArticleSubtype] : null;
}

const LIST_RESOURCE_WORDS = /\b(tools?|software|apps?|platforms?|plugins?|resources|services|providers|agencies|companies|vendors)\b/;
const LIST_EXAMPLE_WORDS = /\b(examples?|templates?|ideas|samples?|case studies|prompts)\b/;

export function classifyKeyword(term: string, intent?: KeywordIntent | null): KeywordTaxonomy {
  const t = ` ${term.trim().toLowerCase().replace(/\s+/g, " ")} `;

  if (/\b(how to|how do|how can|how does|step by step|tutorial|setup|set up|install)\b/.test(t) || /\bguide\b/.test(t)) {
    return { article_type: "guide", article_subtype: "howTo" };
  }
  if (/\b(what is|what are|what does|why|meaning|definition|explained)\b/.test(t)) {
    return { article_type: "guide", article_subtype: "explainer" };
  }
  if (/ vs\.? | versus |\balternatives?\b|\bcompar(e|ison)\b|\bor\b.*\bwhich\b|\bdifference between\b/.test(t)) {
    return { article_type: "guide", article_subtype: "comparison" };
  }
  // Ordinal or count openers ("10 ways", "top 5") and superlatives are lists;
  // which list depends on whether the noun is a thing you pick or a thing you
  // copy.
  const listy = /\b(best|top|\d+)\b/.test(t) || /\blist of\b/.test(t);
  if (LIST_EXAMPLE_WORDS.test(t)) return { article_type: "listicle", article_subtype: "examples" };
  if (LIST_RESOURCE_WORDS.test(t)) return { article_type: "listicle", article_subtype: "resources" };
  if (listy) return { article_type: "listicle", article_subtype: "roundup" };
  if (/\b(checklist|glossary|cheat sheet|specification|specs|requirements|pricing|cost)\b/.test(t)) {
    return { article_type: "guide", article_subtype: "reference" };
  }
  // A commercial query with no format words is usually someone choosing: a
  // comparison serves them better than a definition.
  if (intent === "commercial" || intent === "transactional") {
    return { article_type: "guide", article_subtype: "comparison" };
  }
  return { article_type: "guide", article_subtype: "explainer" };
}

// ---------------------------------------------------------------------------
// Length bands
// ---------------------------------------------------------------------------

export type ExpectedLength = "auto" | "short" | "medium" | "long" | "comprehensive";

export const EXPECTED_LENGTHS: ExpectedLength[] = ["auto", "short", "medium", "long", "comprehensive"];

/** Word-count bands. `auto` has none: it takes the research recommendation. */
export const LENGTH_BANDS: Record<Exclude<ExpectedLength, "auto">, { min: number; max: number }> = {
  short: { min: 1200, max: 1600 },
  medium: { min: 1600, max: 2400 },
  long: { min: 2400, max: 3200 },
  comprehensive: { min: 3200, max: 4200 },
};

export const LENGTH_LABELS: Record<ExpectedLength, string> = {
  auto: "Auto (from research)",
  short: "Short · 1,200–1,600 words",
  medium: "Medium · 1,600–2,400 words",
  long: "Long · 2,400–3,200 words",
  comprehensive: "Comprehensive · 3,200–4,200 words",
};

export function isExpectedLength(v: unknown): v is ExpectedLength {
  return typeof v === "string" && (EXPECTED_LENGTHS as string[]).includes(v);
}

/**
 * The word count to write to. A named band resolves to its midpoint so the
 * scorer and the prompt agree on one number; `auto` (or an unknown value)
 * defers to what the research recommended, which may itself be undefined.
 */
export function targetWordCountFor(
  expected: string | null | undefined,
  recommended: number | undefined,
): number | undefined {
  if (expected && expected !== "auto" && expected in LENGTH_BANDS) {
    const band = LENGTH_BANDS[expected as keyof typeof LENGTH_BANDS];
    return Math.round((band.min + band.max) / 2);
  }
  return recommended;
}
