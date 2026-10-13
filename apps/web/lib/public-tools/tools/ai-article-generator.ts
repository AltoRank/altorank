// ---------------------------------------------------------------------------
// AI article draft generator: a short first draft in Markdown
// ---------------------------------------------------------------------------
//
// A starting point, capped at about 800 words, and labelled as unverified.
// The draft is returned as a Markdown code block so the visitor copies the
// source rather than a rendering of it.

import { z } from "zod";
import { defineTool } from "../types";
import { askHaiku } from "../ai";
import { ToolError } from "../errors";
import { code, kv, text, type KvItem } from "../blocks";
import { countWords, optionalText, requiredText } from "../fields";
import { INPUT_RULES, stripFence, tagged } from "../prompt";

const SLUG = "ai-article-generator";
export const TARGET_WORDS = 800;

const SYSTEM = [
  "You write short first drafts of blog articles for a person to edit.",
  `Write one draft of 500 to ${TARGET_WORDS} words in Markdown: an H1 title, a two- or three-sentence opening that answers the main question, then 3 to 5 H2 sections, and a short closing section.`,
  "If a target keyword is given, use it in the title and the opening, and otherwise only where it reads naturally.",
  "You have no sources and no first-hand experience: do not state statistics, study results, prices, dates or quotes. Where the writer should add a fact, example or figure of their own, write a bracketed note like [Add: your own example of ...].",
  "Output only the Markdown, with no preface and no code fence.",
  INPUT_RULES,
].join("\n");

export const aiArticleGenerator = defineTool({
  slug: SLUG,
  kind: "ai",
  input: z.object({
    topic: requiredText("a topic", 200),
    keyword: optionalText("the keyword", 100),
  }),
  perIpLimit: { limit: 5, windowMs: 60 * 60 * 1000 },
  estimateCents: 1,
  async run({ topic, keyword }, ctx) {
    const res = await askHaiku({
      tool: SLUG,
      system: SYSTEM,
      user: [tagged("topic", topic), keyword ? tagged("keyword", keyword) : ""].filter(Boolean).join("\n"),
      maxTokens: 1500,
      temperature: 0.7,
      signal: ctx.signal,
    });
    const draft = stripFence(res.text);
    if (!draft) throw new ToolError("upstream", "The AI step returned nothing. Try again.");

    const words = countWords(draft);
    const placeholders = (draft.match(/\[Add:[^\]]*\]/gi) ?? []).length;
    const items: KvItem[] = [
      { label: "Length", value: `${words} words`, status: "info" },
      { label: "Places to add your own facts", value: String(placeholders), status: placeholders ? "info" : "pass" },
      { label: "Sources", value: "none: every factual statement needs checking", status: "warn" },
    ];
    if (keyword) {
      const title = draft.split("\n").find((l) => l.startsWith("# ")) ?? "";
      const inTitle = title.toLowerCase().includes(keyword.toLowerCase());
      items.push({ label: "Keyword in title", value: inTitle ? "yes" : "no", status: inTitle ? "pass" : "info" });
    }
    if (res.truncated) items.push({ label: "Complete", value: "no: the draft was cut off at the length cap", status: "warn" });

    return [
      kv(items, "Draft"),
      code(draft, "markdown", "Draft article (Markdown)"),
      text(
        "This is raw material, not a publishable article. It has no first-hand experience and no verified sources, and it can state wrong things confidently. Fact-check it, replace the [Add: ...] notes with what you know, and edit it before anyone reads it.",
        "Before you publish",
      ),
    ];
  },
});
