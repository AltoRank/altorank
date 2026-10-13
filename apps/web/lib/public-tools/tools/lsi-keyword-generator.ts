// ---------------------------------------------------------------------------
// Related terms generator (page slug: lsi-keyword-generator)
// ---------------------------------------------------------------------------
//
// The slug keeps the name people search for. The output does not: it lists
// the subtopics, entities and related terms a complete page on the keyword
// would cover, for a coverage check, and says where they come from.

import { z } from "zod";
import { defineTool } from "../types";
import { askHaikuJson } from "../ai";
import { list, text, type Block } from "../blocks";
import { requiredText } from "../fields";
import { INPUT_RULES, JSON_ONLY, tagged } from "../prompt";

const SLUG = "lsi-keyword-generator";

const Answer = z.object({
  subtopics: z.array(z.string()).default([]),
  entities: z.array(z.string()).default([]),
  related_terms: z.array(z.string()).default([]),
  questions: z.array(z.string()).default([]),
});

const SYSTEM = [
  "You list what a thorough web page about a keyword would naturally cover.",
  "Return four lists: 8 to 12 subtopics (sections a complete treatment needs); 6 to 12 entities (specific named things: organisations, products, standards, laws, places, concepts with proper names) that belong in the topic; 10 to 15 related terms and phrases (vocabulary a knowledgeable writer would use); 5 to 8 questions a reader typically has.",
  "Only include items genuinely relevant to the keyword's most likely meaning. Short items, no explanations, no duplicates across lists.",
  'Shape: {"subtopics":[],"entities":[],"related_terms":[],"questions":[]}',
  JSON_ONLY,
  INPUT_RULES,
].join("\n");

const dedupe = (xs: string[]) => [...new Map(xs.map((x) => [x.trim().toLowerCase(), x.trim()])).values()].filter(Boolean);

export const lsiKeywordGenerator = defineTool({
  slug: SLUG,
  kind: "ai",
  input: z.object({ keyword: requiredText("a keyword", 100) }),
  perIpLimit: { limit: 5, windowMs: 60 * 60 * 1000 },
  estimateCents: 0.6,
  async run({ keyword }, ctx) {
    const { data } = await askHaikuJson({
      tool: SLUG,
      system: SYSTEM,
      user: tagged("keyword", keyword),
      maxTokens: 900,
      temperature: 0.4,
      schema: Answer,
      signal: ctx.signal,
    });
    const blocks: Block[] = [];
    const groups: Array<[string, string[]]> = [
      ["Subtopics a complete page covers", data.subtopics],
      ["Entities", data.entities],
      ["Related terms", data.related_terms],
      ["Questions readers ask", data.questions],
    ];
    for (const [title, items] of groups) {
      const clean = dedupe(items);
      if (clean.length) blocks.push(list(clean, title));
    }
    blocks.push(
      text(
        "These come from a language model reasoning about the topic, not from a search database, so a term being related does not mean anyone searches for it. Use the list to find gaps in your page's coverage, and explain what belongs; inserting words to reach a count does nothing.",
        "How to use this",
      ),
    );
    return blocks;
  },
});
