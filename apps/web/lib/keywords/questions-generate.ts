// ---------------------------------------------------------------------------
// Writing the questions: the model call, server only
// ---------------------------------------------------------------------------
//
// Split from ./questions.ts so the planner card can read stored questions
// without bundling the model client or the spend scope (node:async_hooks).
// See that file for what the questions are for.

import Anthropic from "@anthropic-ai/sdk";
import { anthropicModel, replyText } from "@/lib/ai/models";
import { createMetered } from "@/lib/ai/metered";
import { isBudgetRefusal, withStage } from "@/lib/billing/spend-scope";
import type { BusinessProfile } from "@/lib/onboarding/business-profile";
import { parseQuestionBatch, QUESTION_BATCH_SIZE, toQualityQuestions, type QualityQuestion } from "./questions";

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
      // Metered (lib/ai/metered.ts): written to spend, and under a first
      // look's budget claimed before it is sent, as the `questions` stage.
      const response = await withStage("questions", () => createMetered(client, {
        model: anthropicModel("structured"),
        // Sized to the batch: four short questions a term is under 200
        // tokens in any language the product writes. The claim is this
        // ceiling, and a flat 4,000 (about $0.02) was refused on a first look
        // whose research had used its room, for a call that costs $0.001.
        max_tokens: Math.min(4000, 300 + 200 * batch.length),
        messages: [
          {
            role: "user",
            content: [PROMPT, about, "KEYWORDS:", ...batch.map((t) => `- ${t}`)].filter(Boolean).join("\n\n"),
          },
        ],
      }, "keywords/questions"));
      const raw = replyText(response.content) ?? "";
      for (const [term, qs] of parseQuestionBatch(raw, batch)) out.set(term, qs);
    } catch (err) {
      console.warn("[questions] generation failed for a batch:", err instanceof Error ? err.message : err);
      // The budget will not cover the next batch either: the rest stay
      // without questions, which the card already offers to fill later.
      if (isBudgetRefusal(err)) break;
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
