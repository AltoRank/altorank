// ---------------------------------------------------------------------------
// Micro-rewrites: one field, one selection, one instruction
// ---------------------------------------------------------------------------
//
// The article generator in lib/content/generate.ts researches a keyword and
// writes a whole piece, then stores it. This is the other end of the scale: a
// title, a meta description or a highlighted sentence, rewritten under one
// short instruction, and handed back as text for the editor to *propose*.
// Nothing here touches the database. The editor shows old and new side by
// side and the person accepts or discards; the Save button is the only write.
//
// The prompt is small and the work is shaped and checkable, which is what the
// `structured` tier exists for (see lib/ai/models.ts).

import Anthropic from "@anthropic-ai/sdk";
import { anthropicModel } from "./models";
import { stripAiTypography, stripDeadLinks } from "./utils";

export type MicroField = "title" | "meta_description" | "selection";

export type MicroAction = "improve" | "shorten" | "expand" | "simplify" | "grammar" | "ask";

/** The six actions, in the order the menus show them. */
export const MICRO_ACTIONS: ReadonlyArray<{ id: MicroAction; label: string }> = [
  { id: "improve", label: "Improve" },
  { id: "shorten", label: "Shorten" },
  { id: "expand", label: "Expand" },
  { id: "simplify", label: "Simplify" },
  { id: "grammar", label: "Fix grammar" },
  { id: "ask", label: "Ask AI" },
];

/**
 * Character ceilings the counters show. Counts, not metrics: a title past 60
 * characters is truncated in a result page, a description past 160 is cut
 * mid-sentence. Both are what Google displays, measured, not a target we set.
 */
export const FIELD_LIMITS: Record<Exclude<MicroField, "selection">, number> = {
  title: 60,
  meta_description: 160,
};

export interface MicroContext {
  keyword?: string | null;
  title?: string | null;
  /** The article's H2s, so a rewrite of the title knows what it is titling. */
  outline?: string[] | null;
}

export interface RewriteFieldInput {
  field: MicroField;
  text: string;
  action: MicroAction;
  /** Required when `action` is "ask"; ignored otherwise. */
  prompt?: string;
  context?: MicroContext;
}

const ACTION_INSTRUCTION: Record<Exclude<MicroAction, "ask">, string> = {
  improve: "Improve it: clearer, more specific, more compelling, same meaning and length.",
  shorten: "Shorten it. Cut words, keep every fact and the meaning.",
  expand: "Expand it with more specificity. Add substance, not filler.",
  simplify: "Simplify it. Shorter sentences, plainer words, no jargon, same meaning.",
  grammar: "Fix grammar, spelling and punctuation only. Change nothing else.",
};

const FIELD_RULES: Record<MicroField, string> = {
  title: `This is an article title. Return plain text, one line, no quotes, no trailing period, at most ${FIELD_LIMITS.title} characters. Keep the target keyword.`,
  meta_description: `This is a meta description. Return plain text, one or two sentences, at most ${FIELD_LIMITS.meta_description} characters, no quotes. Keep the target keyword; make it worth clicking.`,
  selection:
    "This is an HTML fragment selected inside an article. Return HTML only, using the same tags. Every <a> (with its href) and every <img> (with its src and alt) in the input must appear unchanged in the output; you may move them, never drop or invent them. Do not add headings or wrap the whole thing in a new element.",
};

/**
 * Prompt text that stops the model writing the way models write. Same rules
 * as the article brief, cut to the size of the job.
 */
const STYLE_RULES = [
  "Write like a careful human editor, not a marketer.",
  'Never use: "delve", "tapestry", "realm", "unlock", "elevate", "game-changer", "in today\'s fast-paced world", "in the ever-evolving landscape", "it\'s important to note".',
  "Never use an em dash. Use a comma, colon, period or parentheses.",
  "Return the rewritten text and nothing else: no preamble, no explanation, no code fence, no quotation marks around it.",
];

export function buildMicroPrompt(input: RewriteFieldInput): { system: string; user: string } {
  const { field, text, action, prompt, context } = input;

  const system = [
    "You rewrite one piece of an article on request.",
    FIELD_RULES[field],
    ...STYLE_RULES,
  ].join("\n");

  const ctx: string[] = [];
  if (context?.keyword) ctx.push(`Target keyword: ${context.keyword}`);
  if (context?.title && field !== "title") ctx.push(`Article title: ${context.title}`);
  if (context?.outline?.length) ctx.push(`Article sections:\n- ${context.outline.slice(0, 12).join("\n- ")}`);

  const instruction =
    action === "ask"
      ? `Instruction from the editor: ${(prompt ?? "").trim() || "Improve it."}`
      : ACTION_INSTRUCTION[action];

  const user = [
    ctx.length ? ctx.join("\n") + "\n" : "",
    instruction,
    "",
    field === "selection" ? "Fragment:" : "Current text:",
    text,
  ].join("\n");

  return { system, user };
}

/**
 * Strip a fence, surrounding quotes, and for the plain-text fields any tag
 * the model wrapped the answer in. Models answer "return plain text" with
 * `<p>…</p>` and "return one line" with `"…"` often enough that the prompt
 * alone does not hold.
 */
export function parseMicroResponse(raw: string, field: MicroField): string {
  let s = raw.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```[a-zA-Z]*\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  }
  if (field === "selection") return sanitizeFragment(s);

  s = s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  // Only when the whole answer is quoted; a quote inside a title is content.
  if (/^["“].*["”]$/.test(s)) s = s.slice(1, -1).trim();
  if (field === "title") s = s.replace(/\.\s*$/, "");
  return stripAiTypography(s).trim();
}

/**
 * Drop what must never reach the editor from a model response: scripts,
 * styles, frames, inline handlers and javascript: URLs. Tiptap's schema then
 * drops any tag it does not know when the fragment is parsed, so this only
 * has to catch what a schema parse could turn into an execution.
 */
export function sanitizeFragment(html: string): string {
  return stripDeadLinks(
    stripAiTypography(html)
      .replace(/<(script|style|iframe|object|embed|form)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<(script|style|iframe|object|embed|form|input)\b[^>]*\/?>/gi, "")
      .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1=$2#$2'),
  ).trim();
}

/** Every href and img src in a fragment, so a caller can check none went missing. */
export function fragmentAssets(html: string): { hrefs: string[]; srcs: string[] } {
  const hrefs = [...html.matchAll(/<a\b[^>]*href=["']([^"']*)["']/gi)].map((m) => m[1]);
  const srcs = [...html.matchAll(/<img\b[^>]*src=["']([^"']*)["']/gi)].map((m) => m[1]);
  return { hrefs, srcs };
}

/**
 * True when every link and image in `before` is still in `after`. The prompt
 * asks for it; this is what makes it a rule. A rewrite that lost a link is
 * returned to the caller as an error, not proposed.
 */
export function keepsAssets(before: string, after: string): boolean {
  const a = fragmentAssets(before);
  const b = fragmentAssets(after);
  return a.hrefs.every((h) => b.hrefs.includes(h)) && a.srcs.every((s) => b.srcs.includes(s));
}

export interface RewriteFieldResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export async function rewriteField(
  input: RewriteFieldInput,
  client: Anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
): Promise<RewriteFieldResult> {
  if (!input.text.trim()) throw new Error("Nothing to rewrite");
  if (input.action === "ask" && !input.prompt?.trim()) throw new Error("Say what to change");

  const { system, user } = buildMicroPrompt(input);
  const message = await client.messages.create({
    model: anthropicModel("structured"),
    // A selection can be a few paragraphs; the fields are a line.
    max_tokens: input.field === "selection" ? 4096 : 400,
    system,
    messages: [{ role: "user", content: user }],
  });

  const raw = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  let text = parseMicroResponse(raw, input.field);
  if (!text) throw new Error("The model returned nothing usable");
  if (input.field === "selection" && !keepsAssets(input.text, text)) {
    throw new Error("The rewrite dropped a link or image, so it was not proposed. Try again or select less.");
  }
  let inputTokens = message.usage?.input_tokens ?? 0;
  let outputTokens = message.usage?.output_tokens ?? 0;

  // The prompt states the limit; the model ignores it about half the time on
  // "shorten" (live: 178 and 173 characters against a 160 limit). One retry
  // that quotes the overshoot brings it under; a second miss is shown as-is,
  // over, so the counter tells the truth rather than a loop burning tokens.
  const limit = input.field === "selection" ? null : FIELD_LIMITS[input.field];
  if (limit && text.length > limit) {
    const retry = await client.messages.create({
      model: anthropicModel("structured"),
      max_tokens: 400,
      system,
      messages: [
        { role: "user", content: user },
        { role: "assistant", content: text },
        { role: "user", content: `That is ${text.length} characters; the limit is ${limit}. Return the same idea in at most ${limit} characters, plain text only.` },
      ],
    });
    const retried = parseMicroResponse(
      retry.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join(""),
      input.field,
    );
    if (retried && retried.length < text.length) text = retried;
    inputTokens += retry.usage?.input_tokens ?? 0;
    outputTokens += retry.usage?.output_tokens ?? 0;
  }

  return { text, inputTokens, outputTokens };
}

// ---------------------------------------------------------------------------
// Whole-article rewrite
// ---------------------------------------------------------------------------
//
// Same idea at the size of the piece. The model gets the article as HTML and
// one instruction, and returns the article as HTML followed by a short
// "what changed" list. It is streamed so the panel can show progress, and
// stored nowhere: the editor keeps it in component state until the person
// presses "Replace article", and even then only Save writes it.

export interface RewriteArticleInput {
  html: string;
  instruction: string;
  context?: MicroContext;
}

export const REWRITE_PLAN_LINE =
  "I'll rewrite the article to your instruction, keeping structure, links, images intact.";

export function buildRewriteArticlePrompt(input: RewriteArticleInput): { system: string; user: string } {
  const system = [
    "You edit an existing article to one instruction. You are an editor, not a new writer.",
    "Return the full article as HTML using only the tags already present (h2, h3, p, ul, ol, li, strong, em, a, img, table, tr, th, td, blockquote, code, pre, hr).",
    "Keep every <a> with its exact href and every <img> with its exact src and alt. You may move them; never drop or invent one.",
    "Keep the heading structure unless the instruction is about structure.",
    "Do not add an <h1>: the title is a separate field.",
    ...STYLE_RULES.slice(0, 3),
    'After the HTML, on its own lines, write exactly three bullets inside <what-changed>…</what-changed>, each as <li>…</li>, saying concretely what you changed. Nothing after the closing tag.',
    "No code fence, no preamble.",
  ].join("\n");

  const ctx: string[] = [];
  if (input.context?.title) ctx.push(`Article title: ${input.context.title}`);
  if (input.context?.keyword) ctx.push(`Target keyword: ${input.context.keyword}`);

  const user = [
    ctx.join("\n"),
    "",
    `Instruction: ${input.instruction.trim()}`,
    "",
    "Article:",
    input.html,
  ].join("\n");

  return { system, user };
}

export interface RewriteArticleParsed {
  html: string;
  changes: string[];
}

/** Split the streamed answer into the article and its change list. */
export function parseRewriteArticleResponse(raw: string): RewriteArticleParsed {
  let s = raw.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```[a-zA-Z]*\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  }
  const m = s.match(/<what-changed>([\s\S]*?)<\/what-changed>/i);
  const changes = m
    ? [...m[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
        .map((li) => li[1].replace(/<[^>]+>/g, "").trim())
        .filter(Boolean)
        .slice(0, 3)
    : [];
  const html = sanitizeFragment(
    s.replace(/<what-changed>[\s\S]*?<\/what-changed>/i, "").replace(/<h1\b[^>]*>[\s\S]*?<\/h1>/i, ""),
  );
  return { html, changes };
}
