// ---------------------------------------------------------------------------
// Decision evals: the shape of a case, a label and a prediction
// ---------------------------------------------------------------------------
//
// A case is a file, never a database row: a business, the terms it was
// offered, and for each term the evidence the decision reads (the results
// page, as `fetchAdvancedSerp` returns it) and a label a person wrote from
// that evidence. The harness runs the product's own decision code on the
// evidence and compares its answer with the label.
//
// Cases about real customers never live in this repository. The harness is
// pointed at a directory (`--fixtures` or ALTORANK_EVAL_FIXTURES); the public
// sample under lib/evals/fixtures/sample is invented.

import type { ArticleShape } from "@/lib/keyword-research/opportunity";
import type { FitProfile, Funnel } from "@/lib/keyword-research/buyer-fit";
import type { SerpData } from "@/lib/seo/brief-data";

/**
 * What the whole topic decision should come to for a term.
 *
 * `buyer_mismatch` is decided by the buyer test, before any results page is
 * read; the results judge scores it as right when it rejects the term for
 * any reason. `needs_serp` means the evidence to label it was missing: the
 * term is left out of the scores rather than guessed.
 */
export type TopicLabel = "qualified" | "not_editorial" | "needs_page" | "existing_page" | "buyer_mismatch" | "needs_serp";
export const TOPIC_LABELS: readonly TopicLabel[] = ["qualified", "not_editorial", "needs_page", "existing_page", "buyer_mismatch", "needs_serp"];

export type FitLabel = "keep" | "reject";

/**
 * What a cited page does for the sentence that cites it.
 * `misattributed`: the page carries the figure, but the sentence credits a
 * different source (a survey's number quoted from a vendor's blog post), or
 * names a body the page shows is not the one the sentence says it is.
 */
export type ClaimLabel = "supported" | "unsupported" | "misattributed";

export interface TermCase {
  term: string;
  /**
   * Searches a month, when measured. Ranks disagreements, and orders the
   * plan scorer's candidates (./plan.ts): absent or null is unmeasured.
   */
  volume?: number | null;
  /** The provider's keyword difficulty (0-100), when stored: the plan scorer's winnability. Absent is unknown. */
  difficulty?: number | null;
  /** The page on the site the term came from, if any (existing-page check). */
  sourceUrl?: string | null;
  /**
   * The buyer verdict production stored for this term. The results judge is
   * run in isolation: a kept verdict's reason is passed through as it was, a
   * rejected or missing one is replaced by a plain keep with no reason.
   */
  storedFit?: { keep: boolean; reason: string | null; funnel?: Funnel } | null;
  /**
   * The results page. Absent: not captured yet (`--capture-serp` buys it).
   * Null: deliberately not captured (the term is labelled without one).
   */
  serp?: { organic: SerpData["organic"]; capturedAt: string } | null;
  label: {
    fit?: FitLabel;
    verdict?: TopicLabel;
    /** For a qualified term: what the winning results are shaped like. */
    shape?: ArticleShape;
    /** For a kept term: whose search it is. */
    funnel?: Funnel;
    /**
     * Business value, 0-3, as a person grades it: 3 the answer is one of the
     * owner's services, 2 a problem a service solves asked by a likely
     * customer, 1 general interest in the field, 0 no path to the business.
     * Optional: the plan scorer reads it where it is written.
     */
    value?: 0 | 1 | 2 | 3;
    /** The owner's service the topic leads to, as the case's offerings name it. */
    service?: string;
    /** Why, in a sentence, from the evidence. Shown next to a disagreement. */
    note?: string;
  };
}

export interface DecisionCase {
  id: string;
  domain: string;
  languageCode: string;
  locationCode: number;
  business: FitProfile;
  /** The date the prompts carry, pinned so a stored answer replays. */
  today: string;
  /** The site's domain rating when the case was captured: the plan scorer's winnability. Absent is unknown. */
  authority?: number | null;
  terms: TermCase[];
}

export interface ClaimCase {
  id: string;
  language: string;
  /** Whether the article is on a health, legal, financial or safety topic (turns on regulator/insurer claims). */
  sensitive?: boolean;
  /** The paragraph(s) carrying the claims, as the article's HTML. */
  html: string;
  /** Cited URL to a stored copy of the page, relative to the claims file. */
  pages: Record<string, string>;
  expect: Array<{ id: string; match: string; label: ClaimLabel; note?: string }>;
}

/** `plan` is scored as plans (./plan.ts), not as agreement: it adds no `Scored` items. */
export type DecisionName = "buyer-fit" | "qualification" | "pipeline" | "fact-check" | "plan";

/** One scored item: what the label says, what the product said, and why. */
export interface Scored {
  decision: DecisionName;
  caseId: string;
  item: string;
  expected: string;
  predicted: string;
  agrees: boolean;
  /** The product's stated reason (the model's, for a model decision). */
  reason?: string | null;
  note?: string | null;
  volume?: number | null;
  /** Qualified on both sides: did the shape match? */
  shape?: { expected: string; predicted: string | null };
}
