// ---------------------------------------------------------------------------
// SEO title generator: title tag options for one page
// ---------------------------------------------------------------------------
//
// The model writes the options; the code measures them. Google cuts titles by
// pixel width (about 600px on desktop), so each option gets an estimated
// width from per-character Arial widths at the result-page size. It is an
// estimate and says so: the visitor still checks the one they pick.
//
// One width model for the whole site: the SERP preview and the headline
// analyzer on altorank.co measure titles on a canvas in 18px Arial against
// 600px (marketing repo, src/components/tools/lib/serp-width.ts). A server
// has no canvas, so this uses Arial's own advance widths at the same size and
// the same limit. Before, a ~20px table against 580px read about 10% wider,
// and the same title was "may be cut" here and "fits" on the next page.

import { z } from "zod";
import { defineTool } from "../types";
import { askHaikuJson } from "../ai";
import { table, text, type Block } from "../blocks";
import { optionalText, requiredText } from "../fields";
import { INPUT_RULES, JSON_ONLY, charLength, tagged } from "../prompt";

const SLUG = "seo-title-generator";

/** Google's desktop title size, matching the marketing site's TITLE_FONT. */
export const TITLE_FONT_PX = 18;
/** Where a desktop title is treated as cut, matching the marketing site's TITLE_PX. */
export const TITLE_PX_LIMIT = 600;

/**
 * Arial advance widths for printable ASCII (space to "~"), in 1/1000 em.
 * Arial is metric-compatible with Helvetica, so these are the standard
 * Helvetica AFM widths.
 */
// prettier-ignore
const ARIAL_ASCII = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, //  !"#$%&'()*+,-./
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, // 0-9 :;<=>?
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, // @A-O
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, // P-Z [\]^_
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, // `a-o
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, // p-z {|}~
];

/** Arial widths for the punctuation titles use most outside ASCII. */
const ARIAL_EXTRA: Record<string, number> = {
  "\u2013": 556, // en dash
  "\u2014": 1000, // em dash
  "\u2018": 222,
  "\u2019": 222,
  "\u201c": 333,
  "\u201d": 333,
  "\u2026": 1000, // ellipsis
  "\u00a0": 278, // no-break space
  "\u00b7": 278, // middle dot
  "\u2022": 350, // bullet
  "\u00ae": 737,
  "\u00a9": 737,
  "\u2122": 1000,
};

/** A letter with an accent is as wide as the letter; anything unknown counts as a digit. */
function charUnits(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp >= 32 && cp <= 126) return ARIAL_ASCII[cp - 32];
  if (ch in ARIAL_EXTRA) return ARIAL_EXTRA[ch];
  const base = ch.normalize("NFD")[0];
  const bcp = base?.codePointAt(0) ?? 0;
  if (base !== ch && bcp >= 32 && bcp <= 126) return ARIAL_ASCII[bcp - 32];
  return 556;
}

/** Pixel width of a title in 18px Arial, the size the marketing site's SERP preview measures. */
export function estimateTitlePx(title: string): number {
  let units = 0;
  for (const ch of title) units += charUnits(ch);
  return Math.round((units * TITLE_FONT_PX) / 1000);
}

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
        `Widths are estimated in 18px Arial, the same way the SERP preview on altorank.co measures them; Google cuts desktop titles at roughly ${TITLE_PX_LIMIT}px. Anything marked "may be cut" is likely to lose its end in results. The options come from your description alone: the model has not seen your page or the current results, so check the one you pick against both.`,
        "Before you use one",
      ),
    ];
    return blocks;
  },
});
