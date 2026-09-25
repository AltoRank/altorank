// ---------------------------------------------------------------------------
// Headline generator: H1 options for an article, from its topic
// ---------------------------------------------------------------------------

import { z } from "zod";
import { defineTool } from "../types";
import { askHaikuJson } from "../ai";
import { table, text } from "../blocks";
import { requiredText } from "../fields";
import { INPUT_RULES, JSON_ONLY, charLength, tagged } from "../prompt";

const SLUG = "headline-generator";

const Answer = z.object({
  headlines: z
    .array(z.object({ headline: z.string().min(1), pattern: z.string().default("") }))
    .min(1)
    .max(14),
});

const SYSTEM = [
  "You write headlines (the visible H1) for blog posts and articles.",
  "Given a topic, write 10 distinct headline options that say plainly what the piece is about.",
  "Mix patterns: how-to, list, question, direct statement, outcome, mistake/warning, comparison. Label each with its pattern.",
  "Clear beats clever. No clickbait, no all caps, no emoji, no invented numbers of results; a list headline may use a number of items.",
  'Shape: {"headlines":[{"headline":"...","pattern":"how-to"}]}',
  JSON_ONLY,
  INPUT_RULES,
].join("\n");

export const headlineGenerator = defineTool({
  slug: SLUG,
  kind: "ai",
  input: z.object({ topic: requiredText("a topic", 200) }),
  perIpLimit: { limit: 5, windowMs: 60 * 60 * 1000 },
  estimateCents: 0.5,
  async run({ topic }, ctx) {
    const { data } = await askHaikuJson({
      tool: SLUG,
      system: SYSTEM,
      user: tagged("topic", topic),
      maxTokens: 700,
      temperature: 0.9,
      schema: Answer,
      signal: ctx.signal,
    });
    return [
      table(
        ["Headline", "Pattern", "Characters"],
        data.headlines.map((h) => [h.headline, h.pattern, charLength(h.headline)]),
        "Headline options",
      ),
      text(
        "These come from your topic alone; the model has not read your article. Pick the pattern that matches how the piece is built, then rewrite it so it promises exactly what the article delivers.",
        "Before you use one",
      ),
    ];
  },
});
