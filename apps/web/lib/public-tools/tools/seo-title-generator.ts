// ---------------------------------------------------------------------------
// SEO title generator: title tag options for one page
// ---------------------------------------------------------------------------
//
// The model writes the options; the code measures them. Google cuts titles by
// pixel width (about 600px on desktop), so each option gets an estimated
// width from per-character Arial widths at the result-page size. It is an
// estimate and says so: the visitor still checks the one they pick.

import { z } from "zod";
import { defineTool } from "../types";
import { askHaikuJson } from "../ai";
import { table, text, type Block } from "../blocks";
import { optionalText, requiredText } from "../fields";
import { INPUT_RULES, JSON_ONLY, charLength, tagged } from "../prompt";

const SLUG = "seo-title-generator";

/** Rough pixel width of a title at Google's desktop title size (Arial ~20px). */
export function estimateTitlePx(title: string): number {
  let px = 0;
  for (const ch of title) {
    if (/[ijlI.,;:'!|]/.test(ch)) px += 5;
    else if (/[ftr()\[\]\- ]/.test(ch)) px += 6.5;
    else if (/[mwMW]/.test(ch)) px += 17;
    else if (/[A-Z]/.test(ch)) px += 13;
    else if (/[0-9a-z]/.test(ch)) px += 10.5;
    else px += 11;
  }
  return Math.round(px);
}

export const TITLE_PX_LIMIT = 580;

const Answer = z.object({
  titles: z
    .array(z.object({ title: z.string().min(1), angle: z.string().default("") }))
    .min(1)
    .max(12),
});

const SYSTEM = [
  "You write title tags for web pages.",
  "Given what a page is about and, optionally, the search keyword it targets, write 8 distinct title tag options.",
  "Rules: put the keyword (or the page's subject) near the start; say what the page delivers; aim for 50 to 60 characters; no clickbait, no all caps, no emoji; do not promise anything the description does not support; a brand name only if the visitor gave one.",
  "Vary the angle across options (audience, format, outcome, question, comparison, freshness).",
  'Shape: {"titles":[{"title":"...","angle":"2-4 word label for the angle"}]}',
  JSON_ONLY,
  INPUT_RULES,
].join("\n");

export const seoTitleGenerator = defineTool({
  slug: SLUG,
  kind: "ai",
  input: z.object({
    topic: requiredText("what the page is about", 200),
    keyword: optionalText("the keyword", 100),
  }),
  perIpLimit: { limit: 5, windowMs: 60 * 60 * 1000 },
  estimateCents: 0.5,
  async run({ topic, keyword }, ctx) {
    const { data } = await askHaikuJson({
      tool: SLUG,
      system: SYSTEM,
      user: [tagged("page", topic), keyword ? tagged("keyword", keyword) : ""].filter(Boolean).join("\n"),
      maxTokens: 700,
      temperature: 0.8,
      schema: Answer,
      signal: ctx.signal,
    });

    const kw = keyword?.toLowerCase();
    const rows = data.titles.map(({ title, angle }) => {
      const px = estimateTitlePx(title);
      const row: (string | number)[] = [title, angle, charLength(title), `${px}px${px > TITLE_PX_LIMIT ? " (may be cut)" : ""}`];
      if (kw) row.push(title.toLowerCase().includes(kw) ? "yes" : "no");
      return row;
    });
    const columns = ["Title", "Angle", "Characters", "Est. width"];
    if (kw) columns.push("Has keyword");

    const blocks: Block[] = [
      table(columns, rows, "Title tag options"),
      text(
        `Widths are estimated from typical letter widths; Google cuts desktop titles at roughly 600px. Anything marked "may be cut" loses its end in results. The options come from your description alone: the model has not seen your page or the current results, so check the one you pick against both.`,
        "Before you use one",
      ),
    ];
    return blocks;
  },
});
