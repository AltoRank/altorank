// ---------------------------------------------------------------------------
// Email subject line generator: options with their lengths
// ---------------------------------------------------------------------------
//
// No open-rate scores: nothing here knows the visitor's list. The code does
// what can be checked: counts characters, drops any fake "Re:"/"Fwd:" line
// (deceptive in commercial email), and flags shouting.

import { z } from "zod";
import { defineTool } from "../types";
import { askHaikuJson } from "../ai";
import { table, text } from "../blocks";
import { requiredText } from "../fields";
import { INPUT_RULES, JSON_ONLY, charLength, tagged } from "../prompt";

const SLUG = "email-subject-line-generator";
/** Roughly where a phone inbox cuts the subject. Varies by app and device. */
export const MOBILE_CUT = 40;

const Answer = z.object({
  subject_lines: z
    .array(z.object({ subject: z.string().min(1), preview: z.string().default("") }))
    .min(1)
    .max(14),
});

const SYSTEM = [
  "You write email subject lines.",
  "Given what an email is about, write 10 distinct subject lines, each with a matching preview text (the line inboxes show after the subject, under 90 characters).",
  "Put the most important words first. Be specific and plain; describe the email honestly. Vary the approach: direct, question, benefit, news, how-to.",
  "Never start with Re: or Fwd:. No all caps, no more than one exclamation mark, no emoji, no fake urgency.",
  'Shape: {"subject_lines":[{"subject":"...","preview":"..."}]}',
  JSON_ONLY,
  INPUT_RULES,
].join("\n");

export function subjectNotes(subject: string): string {
  const notes: string[] = [];
  const n = charLength(subject);
  if (n > MOBILE_CUT) notes.push(`may be cut on phones after ~${MOBILE_CUT}`);
  if (/\b[A-Z]{4,}\b/.test(subject)) notes.push("has an all-caps word");
  if (/!{2,}/.test(subject)) notes.push("multiple exclamation marks");
  return notes.join("; ");
}

export const emailSubjectLineGenerator = defineTool({
  slug: SLUG,
  kind: "ai",
  input: z.object({ topic: requiredText("what the email is about", 200) }),
  perIpLimit: { limit: 5, windowMs: 60 * 60 * 1000 },
  estimateCents: 0.5,
  async run({ topic }, ctx) {
    const { data } = await askHaikuJson({
      tool: SLUG,
      system: SYSTEM,
      user: tagged("email", topic),
      maxTokens: 700,
      temperature: 0.9,
      schema: Answer,
      signal: ctx.signal,
    });
    const honest = data.subject_lines.filter((s) => !/^\s*(re|fwd?)\s*:/i.test(s.subject));
    return [
      table(
        ["Subject line", "Characters", "Preview text", "Notes"],
        honest.map((s) => [s.subject, charLength(s.subject), s.preview, subjectNotes(s.subject)]),
        "Subject line options",
      ),
      text(
        "No score or open-rate prediction: the tool knows nothing about your list or past results. Pick the line that describes the email most clearly and, if you can, test two on your own audience.",
        "Picking one",
      ),
    ];
  },
});
