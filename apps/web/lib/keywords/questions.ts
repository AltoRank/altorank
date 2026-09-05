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

import Anthropic from "@anthropic-ai/sdk";
import { anthropicModel } from "@/lib/ai/models";
import type { BusinessProfile } from "@/lib/onboarding/business-profile";

export interface QualityQuestion {
  id: string;
  question: string;
  /** The owner's words, or null until they answer. */
  answer: string | null;
}

export const QUESTIONS_PER_KEYWORD = 4;
/** Terms per model call. Above this the reply gets long enough to truncate. */
export const QUESTION_BATCH_SIZE = 30;

const PROMPT = [
  "You write interview questions for a business owner whose website is about to publish an article.",
  "For each keyword below, write exactly 4 short questions that ask for FIRST-HAND experience",
  "the owner could answer in a sentence or two: what they use, a real example of a result,",
  "what they changed or built, what they would tell a peer. The answers will be quoted in the",
  "article as the owner's own experience, so every question must be answerable only by someone",
  "who has actually done the thing. Never ask for definitions, opinions about the industry, or",
  "anything that could be looked up.",
  "",
  "Make each question specific to its keyword. Reuse the keyword's own nouns.",
  "Plain sentences: no em dashes, no semicolons, no quotation marks inside a question.",
  "",
  "Return ONLY a JSON object, no prose, no code fence, keyed by the keyword exactly as given,",
  'each value an array of 4 strings: {"keyword one": ["q1","q2","q3","q4"], ...}',
].join("\n");

function profileLines(profile: BusinessProfile | null | undefined): string {
  if (!profile) return "";
  const lines = ["ABOUT THE BUSINESS:"];
  if (profile.name) lines.push(`- Name: ${profile.name}`);
  if (profile.description) lines.push(`- What it does: ${profile.description}`);
  if (profile.audiences?.length) lines.push(`- Sells to: ${profile.audiences.join("; ")}`);
  return lines.length > 1 ? lines.join("\n") : "";
}

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

/**
 * Generate questions for many terms in as few model calls as possible.
 *
 * Returns only the terms that came back usable; a caller treats a missing key
 * as "nothing generated" and leaves the stored array empty. No API key, or a
 * model that fails, yields an empty map rather than a throw: question
 * generation is a nicety on top of planning, and a plan must not fail for it.
 */
export async function generateQualityQuestionsBatch(
  terms: string[],
  profile: BusinessProfile | null | undefined,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const unique = [...new Set(terms.map((t) => t.trim()).filter(Boolean))];
  if (!apiKey || unique.length === 0) return out;

  const client = new Anthropic({ apiKey });
  const about = profileLines(profile);
  for (let i = 0; i < unique.length; i += QUESTION_BATCH_SIZE) {
    const batch = unique.slice(i, i + QUESTION_BATCH_SIZE);
    try {
      const response = await client.messages.create({
        model: anthropicModel("structured"),
        max_tokens: 4000,
        messages: [
          {
            role: "user",
            content: [PROMPT, about, "KEYWORDS:", ...batch.map((t) => `- ${t}`)].filter(Boolean).join("\n\n"),
          },
        ],
      });
      const raw = response.content[0]?.type === "text" ? response.content[0].text : "";
      for (const [term, qs] of parseQuestionBatch(raw, batch)) out.set(term, qs);
    } catch (err) {
      console.warn("[questions] generation failed for a batch:", err instanceof Error ? err.message : err);
    }
  }
  return out;
}

/** One keyword's questions, or [] when nothing usable came back. */
export async function generateQualityQuestions(
  term: string,
  profile: BusinessProfile | null | undefined,
): Promise<QualityQuestion[]> {
  const map = await generateQualityQuestionsBatch([term], profile);
  return toQualityQuestions(map.get(term.trim()) ?? []);
}
