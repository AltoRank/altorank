// ---------------------------------------------------------------------------
// Article rewriter: the visitor's own text, in a different tone
// ---------------------------------------------------------------------------
//
// A rewrite is where facts drift, so the code compares the figures in the
// original with the figures in the rewrite and lists any that went missing.
// It cannot catch a softened claim, but it catches the rounded number.
//
// Pasted text is not cached (cacheTtlMs: 0).

import { z } from "zod";
import { defineTool } from "../types";
import { askHaiku } from "../ai";
import { ToolError } from "../errors";
import { kv, list, text, type Block, type KvItem } from "../blocks";
import { countWords, optionalText, pastedText } from "../fields";
import { INPUT_RULES, stripFence, tagged } from "../prompt";

const SLUG = "article-rewriter";

const SYSTEM = [
  "You rewrite the visitor's text in the tone they ask for, keeping its meaning.",
  "Keep every fact, number, name, date, quote and qualifier. Do not add claims, examples or statistics that are not in the original. Keep roughly the same length unless the tone asks for shorter.",
  "Keep the paragraph structure and any headings or list items; you may split long sentences.",
  "If no tone is given, make it clearer and plainer.",
  "Output only the rewritten text, with no preface, notes or code fence.",
  INPUT_RULES,
].join("\n");

/** Numbers as written, normalised: "1,500" and "1500" are one figure. */
export function figures(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of s.matchAll(/\d[\d,.]*\d%?|\d%?/g)) out.add(m[0].replace(/,/g, "").replace(/\.$/, ""));
  return out;
}

export const articleRewriter = defineTool({
  slug: SLUG,
  kind: "ai",
  input: z.object({
    text: pastedText(1500),
    tone: optionalText("the tone", 40),
  }),
  perIpLimit: { limit: 5, windowMs: 60 * 60 * 1000 },
  estimateCents: 2.5,
  cacheTtlMs: 0,
  async run({ text: original, tone }, ctx) {
    const res = await askHaiku({
      tool: SLUG,
      system: SYSTEM,
      user: [tagged("text", original), tone ? tagged("tone", tone) : ""].filter(Boolean).join("\n"),
      maxTokens: 3072,
      temperature: 0.5,
      signal: ctx.signal,
    });
    const rewritten = stripFence(res.text);
    if (!rewritten) throw new ToolError("upstream", "The AI step returned nothing. Try again.");

    const lost = [...figures(original)].filter((f) => !figures(rewritten).has(f));
    const items: KvItem[] = [
      { label: "Words", value: `${countWords(original)} before, ${countWords(rewritten)} after`, status: "info" },
      {
        label: "Figures kept",
        value: lost.length ? `${lost.length} figure${lost.length === 1 ? "" : "s"} from the original not found in the rewrite` : "every figure in the original appears in the rewrite",
        status: lost.length ? "warn" : "pass",
      },
    ];
    if (res.truncated) {
      items.push({ label: "Complete", value: "no: the rewrite was cut off. Rewrite the text in shorter sections.", status: "fail" });
    }

    const blocks: Block[] = [kv(items, tone ? `Rewritten: ${tone}` : "Rewritten")];
    blocks.push(text(rewritten, "Rewritten text"));
    if (lost.length) blocks.push(list(lost.map((f) => `${f} is in your original but not in the rewrite`), "Figures to check"));
    blocks.push(
      text(
        "A rewrite can soften a claim or drop a qualifier without changing any number. Compare it with your original, fact by fact, before you use it.",
        "Before you use it",
      ),
    );
    return blocks;
  },
});
