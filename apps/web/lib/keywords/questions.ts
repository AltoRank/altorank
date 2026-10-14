// ---------------------------------------------------------------------------
// Questions that draw out what only the site owner knows
// ---------------------------------------------------------------------------
//
// Research tells the writer what already ranks. It cannot tell it what this
// particular business has actually done, and that is the one thing a reader
// (or an answer engine) cannot get from the twenty pages already on the SERP.
// So each planned keyword gets a handful of questions that ask for first-hand
// experience, and whatever the owner answers goes into the article as theirs.
//
// The questions are model-generated because they have to be specific to the
// term: "which open-source SEO tool is a staple in your toolkit?" is useful,
// "tell us about your experience" is not. The answers are never generated.
// An unanswered question stays unanswered, and the writer is told nothing.
//
// One call per plan run, not one per keyword: thirty planned keywords is one
// structured request on the cheap tier, parsed defensively. A failure yields
// nothing for that keyword, and the card offers to try again when opened.

//
// Pure: parsing and shapes, safe in a client bundle (the planner card reads
// them). The model call that writes the questions is server-only, in
// ./questions-generate.ts.

export interface QualityQuestion {
  id: string;
  question: string;
  /** The owner's words, or null until they answer. */
  answer: string | null;
}

export const QUESTIONS_PER_KEYWORD = 4;
/** Terms per model call. Above this the reply gets long enough to truncate. */
export const QUESTION_BATCH_SIZE = 30;

/**
 * Pull `terms -> questions` out of a model reply, tolerating a code fence, a
 * sentence of preamble, and case or whitespace drift in the keys. Anything
 * that is not a non-empty string is dropped; a term with fewer than two usable
 * questions gets none, because two half-questions are not a questionnaire.
 *
 * Exported for tests.
 */
export function parseQuestionBatch(raw: string, terms: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return out;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;

  const byKey = new Map<string, unknown>();
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    byKey.set(k.trim().toLowerCase(), v);
  }
  for (const term of terms) {
    const v = byKey.get(term.trim().toLowerCase());
    if (!Array.isArray(v)) continue;
    const qs = v
      .filter((q): q is string => typeof q === "string")
      .map((q) => q.trim())
      .filter((q) => q.length > 8)
      .slice(0, QUESTIONS_PER_KEYWORD);
    if (qs.length >= 2) out.set(term, qs);
  }
  return out;
}

/** Wrap bare question strings as unanswered rows with stable ids. */
export function toQualityQuestions(questions: string[]): QualityQuestion[] {
  return questions.map((question, i) => ({ id: `q${i + 1}`, question, answer: null }));
}

/**
 * Read `keywords.quality_questions` defensively. The column is jsonb with a
 * default of `[]`, but a row written by hand or by an older client is not
 * guaranteed to hold the shape, and a card must never crash on it.
 */
export function parseStoredQuestions(raw: unknown): QualityQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: QualityQuestion[] = [];
  raw.forEach((item, i) => {
    if (!item || typeof item !== "object") return;
    const r = item as Record<string, unknown>;
    if (typeof r.question !== "string" || !r.question.trim()) return;
    const answer = typeof r.answer === "string" && r.answer.trim() ? r.answer : null;
    out.push({ id: typeof r.id === "string" && r.id ? r.id : `q${i + 1}`, question: r.question, answer });
  });
  return out;
}

export function unansweredCount(questions: QualityQuestion[]): number {
  return questions.filter((q) => !q.answer).length;
}
