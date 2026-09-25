// ---------------------------------------------------------------------------
// Article summarizer: a short summary and key points of pasted text
// ---------------------------------------------------------------------------
//
// Works on pasted text only; it never fetches a URL. Pasted text is not
// cached (cacheTtlMs: 0).

import { z } from "zod";
import { defineTool } from "../types";
import { askHaikuJson } from "../ai";
import { kv, list, text } from "../blocks";
import { countWords, pastedText } from "../fields";
import { INPUT_RULES, JSON_ONLY, tagged } from "../prompt";

const SLUG = "article-summarizer";

const Answer = z.object({
  summary: z.string().min(1),
  key_points: z.array(z.string().min(1)).min(1).max(8),
});

const SYSTEM = [
  "You summarize the visitor's text.",
  "Write a summary of 2 to 4 sentences (at most 90 words) stating the main point, then 3 to 7 key points, one sentence each.",
  "Keep caveats and hedges as the text states them: if it says 'may' or 'in one study', so do you. Keep numbers exactly as written. Add nothing that is not in the text.",
  "If the text is too short or not prose, summarize what is there.",
  'Shape: {"summary":"...","key_points":["...","..."]}',
  JSON_ONLY,
  INPUT_RULES,
].join("\n");

export const articleSummarizer = defineTool({
  slug: SLUG,
  kind: "ai",
  input: z.object({ text: pastedText() }),
  perIpLimit: { limit: 5, windowMs: 60 * 60 * 1000 },
  estimateCents: 1,
  cacheTtlMs: 0,
  async run({ text: source }, ctx) {
    const { data } = await askHaikuJson({
      tool: SLUG,
      system: SYSTEM,
      user: tagged("text", source),
      maxTokens: 700,
      temperature: 0.2,
      schema: Answer,
      signal: ctx.signal,
    });
    return [
      text(data.summary, "Summary"),
      list(data.key_points, "Key points"),
      kv([{ label: "Length", value: `${countWords(source)} words in, ${countWords(data.summary)} in the summary`, status: "info" }]),
      text(
        "Summaries drop caveats and round numbers. Check any sentence you plan to reuse against the source, and cite the source, not the summary.",
        "Before you reuse it",
      ),
    ];
  },
});
