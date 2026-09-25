// ---------------------------------------------------------------------------
// Blog outline generator: an H2/H3 skeleton for one post
// ---------------------------------------------------------------------------

import { z } from "zod";
import { defineTool } from "../types";
import { askHaikuJson } from "../ai";
import { code, text } from "../blocks";
import { optionalText, requiredText } from "../fields";
import { INPUT_RULES, JSON_ONLY, tagged } from "../prompt";

const SLUG = "blog-outline-generator";

const Answer = z.object({
  title: z.string().min(1),
  sections: z
    .array(
      z.object({
        h2: z.string().min(1),
        answers: z.string().default(""),
        h3: z.array(z.string()).default([]),
      }),
    )
    .min(2)
    .max(12),
});
type Outline = z.infer<typeof Answer>;

const SYSTEM = [
  "You outline blog posts.",
  "Given a topic and, optionally, the search keyword the post targets, write one outline: a working title (H1) and 5 to 8 H2 sections, each with 0 to 4 H3 subsections.",
  "Order sections the way a reader's questions come up. Phrase headings plainly; where a heading is a question, the section should open with its answer. Use the keyword where it fits naturally, not in every heading.",
  "For each H2, add one short line saying what the section must answer.",
  "No introduction or conclusion headings unless they carry content (a summary of key takeaways is fine).",
  'Shape: {"title":"...","sections":[{"h2":"...","answers":"...","h3":["...","..."]}]}',
  JSON_ONLY,
  INPUT_RULES,
].join("\n");

export function outlineMarkdown(o: Outline): string {
  const lines = [`# ${o.title}`, ""];
  for (const s of o.sections) {
    lines.push(`## ${s.h2}`);
    if (s.answers) lines.push(`<!-- answers: ${s.answers} -->`);
    for (const h of s.h3) lines.push(`### ${h}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

export const blogOutlineGenerator = defineTool({
  slug: SLUG,
  kind: "ai",
  input: z.object({
    topic: requiredText("a topic", 200),
    keyword: optionalText("the keyword", 100),
  }),
  perIpLimit: { limit: 5, windowMs: 60 * 60 * 1000 },
  estimateCents: 0.7,
  async run({ topic, keyword }, ctx) {
    const { data } = await askHaikuJson({
      tool: SLUG,
      system: SYSTEM,
      user: [tagged("topic", topic), keyword ? tagged("keyword", keyword) : ""].filter(Boolean).join("\n"),
      maxTokens: 1000,
      temperature: 0.6,
      schema: Answer,
      signal: ctx.signal,
    });
    const h3Count = data.sections.reduce((n, s) => n + s.h3.length, 0);
    return [
      code(outlineMarkdown(data), "markdown", `Outline: ${data.sections.length} sections, ${h3Count} subsections`),
      text(
        "Built from your topic and general knowledge. The model has not looked at what ranks for this query or what readers ask now, so compare it with the current results, cut what does not fit your angle, and add what only you know.",
        "Before you write",
      ),
    ];
  },
});
