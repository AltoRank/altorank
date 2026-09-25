// ---------------------------------------------------------------------------
// Content idea generator: angles to write about for a topic or niche
// ---------------------------------------------------------------------------
//
// Model brainstorm, not search data, and the output says so. The blog post
// ideas tool is the one grounded in real searches.

import { z } from "zod";
import { defineTool } from "../types";
import { askHaikuJson } from "../ai";
import { table, text } from "../blocks";
import { requiredText } from "../fields";
import { INPUT_RULES, JSON_ONLY, tagged } from "../prompt";

const SLUG = "content-idea-generator";

const Answer = z.object({
  ideas: z
    .array(z.object({ title: z.string().min(1), angle: z.string().default(""), format: z.string().default("") }))
    .min(1)
    .max(15),
});

const SYSTEM = [
  "You brainstorm content ideas for a topic or niche.",
  "Write 12 distinct ideas a specific reader in that niche would want: practical questions, decisions, mistakes, comparisons, how-tos, explainers, checklists, opinion pieces.",
  "For each give a working title, one sentence on the angle (who it is for and what makes it useful), and the format (guide, how-to, list, comparison, checklist, case study, explainer, opinion, template).",
  "Avoid generic 'ultimate guide' ideas unless the angle is specific. Do not claim any idea has search volume or will rank.",
  'Shape: {"ideas":[{"title":"...","angle":"...","format":"how-to"}]}',
  JSON_ONLY,
  INPUT_RULES,
].join("\n");

export const contentIdeaGenerator = defineTool({
  slug: SLUG,
  kind: "ai",
  input: z.object({ topic: requiredText("a topic or niche", 200) }),
  perIpLimit: { limit: 5, windowMs: 60 * 60 * 1000 },
  estimateCents: 0.7,
  async run({ topic }, ctx) {
    const { data } = await askHaikuJson({
      tool: SLUG,
      system: SYSTEM,
      user: tagged("topic", topic),
      maxTokens: 1000,
      temperature: 0.9,
      schema: Answer,
      signal: ctx.signal,
    });
    return [
      table(["Idea", "Angle", "Format"], data.ideas.map((i) => [i.title, i.angle, i.format]), "Content ideas"),
      text(
        "These come from a language model reasoning about your topic, not from search data, so any of them can sound right and have no audience. Validate each against real searches (the keyword research or blog post ideas tools) or a real customer question before you write it.",
        "Before you write",
      ),
    ];
  },
});
