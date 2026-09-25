// ---------------------------------------------------------------------------
// Grammar checker: grammar, spelling and punctuation issues, each with a fix
// ---------------------------------------------------------------------------
//
// The model returns issues, not a rewritten text. The corrected text is built
// here by applying each suggestion to the exact span it names, so it changes
// nothing the table does not list. An issue whose "original" is not found
// verbatim in the text is dropped rather than guessed at.
//
// Pasted text is not cached (cacheTtlMs: 0).

import { z } from "zod";
import { defineTool } from "../types";
import { askHaikuJson } from "../ai";
import { code, kv, table, text, type Block } from "../blocks";
import { pastedText } from "../fields";
import { INPUT_RULES, JSON_ONLY, tagged } from "../prompt";

const SLUG = "grammar-checker";
const MAX_ISSUES = 40;

const Issue = z.object({
  original: z.string().min(1),
  suggestion: z.string(),
  why: z.string().default(""),
  type: z.string().default("grammar"),
});
const Answer = z.object({ issues: z.array(Issue).max(60) });
export type GrammarIssue = z.infer<typeof Issue>;

const SYSTEM = [
  "You proofread the visitor's text for grammar, spelling and punctuation errors only.",
  "Do not rewrite for style, tone or clarity. Do not flag deliberate style choices that are correct either way (British or American spelling, the serial comma, sentence fragments used for effect).",
  `List at most ${MAX_ISSUES} issues, most important first. For each: "original" is the shortest exact span copied character for character from the text that shows the error, with enough words around it to be unique (usually 2 to 6 words); "suggestion" is that span corrected; "why" is under 12 words; "type" is grammar, spelling or punctuation.`,
  'If there are no errors, return {"issues":[]}.',
  'Shape: {"issues":[{"original":"...","suggestion":"...","why":"...","type":"spelling"}]}',
  JSON_ONLY,
  INPUT_RULES,
].join("\n");

export interface AppliedIssue extends GrammarIssue {
  index: number;
}

/**
 * Keep the issues whose span is in the text, in text order, without overlaps,
 * and apply them. Returns the kept issues and the corrected text.
 */
export function applyIssues(source: string, issues: GrammarIssue[]): { kept: AppliedIssue[]; corrected: string } {
  const located: AppliedIssue[] = [];
  const taken: Array<[number, number]> = [];
  for (const issue of issues) {
    if (issue.original === issue.suggestion) continue;
    let from = 0;
    let index = -1;
    // The first occurrence not already claimed by an earlier issue.
    while ((index = source.indexOf(issue.original, from)) >= 0) {
      const end = index + issue.original.length;
      if (!taken.some(([a, b]) => index < b && end > a)) break;
      from = index + 1;
    }
    if (index < 0) continue;
    taken.push([index, index + issue.original.length]);
    located.push({ ...issue, index });
  }
  located.sort((a, b) => a.index - b.index);
  let corrected = "";
  let cursor = 0;
  for (const i of located) {
    corrected += source.slice(cursor, i.index) + i.suggestion;
    cursor = i.index + i.original.length;
  }
  corrected += source.slice(cursor);
  return { kept: located, corrected };
}

export const grammarChecker = defineTool({
  slug: SLUG,
  kind: "ai",
  input: z.object({ text: pastedText(1500) }),
  perIpLimit: { limit: 5, windowMs: 60 * 60 * 1000 },
  estimateCents: 2,
  cacheTtlMs: 0,
  async run({ text: source }, ctx) {
    const { data } = await askHaikuJson({
      tool: SLUG,
      system: SYSTEM,
      user: tagged("text", source),
      maxTokens: 2048,
      temperature: 0,
      schema: Answer,
      signal: ctx.signal,
    });
    const { kept, corrected } = applyIssues(source, data.issues.slice(0, MAX_ISSUES));

    if (!kept.length) {
      return [
        kv([{ label: "Issues found", value: "none", status: "pass" }], "Grammar, spelling and punctuation"),
        text("No errors were flagged. The checker can miss errors that form a real word (form for from), so read the text once more yourself.", "Before you publish"),
      ];
    }

    const byType = new Map<string, number>();
    for (const i of kept) byType.set(i.type, (byType.get(i.type) ?? 0) + 1);
    const blocks: Block[] = [
      kv(
        [
          { label: "Issues found", value: String(kept.length), status: "warn" },
          ...[...byType].map(([type, n]) => ({ label: type[0].toUpperCase() + type.slice(1), value: String(n), status: "info" as const })),
        ],
        "Grammar, spelling and punctuation",
      ),
      table(["Original", "Suggestion", "Why"], kept.map((i) => [i.original, i.suggestion, i.why]), "Suggested corrections"),
      code(corrected, "text", "Your text with every suggestion applied"),
      text(
        "Each suggestion is a proposal: skip any that change something you meant. Nothing else in your text was changed. The checker can also miss errors, so read the final text yourself.",
        "Before you use it",
      ),
    ];
    return blocks;
  },
});
