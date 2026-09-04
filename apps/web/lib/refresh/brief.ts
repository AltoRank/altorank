// ---------------------------------------------------------------------------
// The brief: a short plan for one rewrite
// ---------------------------------------------------------------------------
//
// Sits between the evidence and the model call. The detector says "position
// 8, 340 impressions, 610 words"; the brief says what to do about it: which
// sections to strengthen, which questions to add, what must not change. A
// person can edit it before the rewrite runs, which is the point of having
// one - a rewrite that goes straight from numbers to prose gives the reviewer
// nothing to steer.
//
// Written by the structured-tier model from the evidence and the page's own
// headings. When there is no model key, a deterministic brief is written from
// the evidence alone, so a self-hosted install without Anthropic still gets a
// usable plan and the rewrite step (which needs a model anyway) is where the
// missing key is felt.

import Anthropic from "@anthropic-ai/sdk";
import { anthropicModel } from "@/lib/ai/models";
import { OPPORTUNITY_LABELS, type Evidence, type Opportunity } from "./types";
import { headingMatchesQuery, THRESHOLDS } from "./detect";

export interface BriefInput {
  url: string;
  title: string | null;
  opportunity: Opportunity;
  evidence: Evidence;
  headings: string[];
  wordCount: number | null;
}

/** The structured shape the model is asked for. */
export interface Brief {
  summary: string;
  strengthen: string[];
  questions: string[];
  keep: string[];
}

const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** The evidence, one line per measured field. Unmeasured fields are omitted. */
export function describeEvidence(e: Evidence): string[] {
  const lines: string[] = [];
  if (e.query) lines.push(`Query: "${e.query}"`);
  if (e.position !== null) {
    lines.push(
      e.prev_position !== null
        ? `Position: ${e.position} (was ${e.prev_position} in the previous 28 days)`
        : `Position: ${e.position}`,
    );
  }
  if (e.impressions !== null) lines.push(`Impressions, last 28 days: ${e.impressions.toLocaleString()}`);
  if (e.clicks !== null) {
    lines.push(
      e.prev_clicks !== null
        ? `Clicks, last 28 days: ${e.clicks.toLocaleString()} (was ${e.prev_clicks.toLocaleString()})`
        : `Clicks, last 28 days: ${e.clicks.toLocaleString()}`,
    );
  }
  if (e.ctr !== null) {
    lines.push(
      e.expected_ctr !== null
        ? `CTR: ${fmtPct(e.ctr)} against about ${fmtPct(e.expected_ctr)} expected at this position`
        : `CTR: ${fmtPct(e.ctr)}`,
    );
  }
  if (e.word_count !== null) lines.push(`Length: ${e.word_count.toLocaleString()} words`);
  return lines;
}

/**
 * A plan from the numbers alone. Used when no model is configured, and as
 * the floor a model-written brief has to beat.
 */
export function deterministicBrief(input: BriefInput): Brief {
  const { opportunity, evidence: e, headings } = input;
  const q = e.query ?? "the target query";
  const strengthen: string[] = [];
  const questions: string[] = [];
  const keep = [
    "Every existing internal link, external citation and image.",
    "The section order and the H2 headings that already address the query.",
    "Facts and figures that are still current; refresh only what has aged.",
  ];

  switch (opportunity) {
    case "almost_there":
      strengthen.push(
        `Open with a direct answer for "${q}" in the first paragraph.`,
        `Name "${q}" in the title and in at least one H2.`,
        "Add one specific, sourced figure to each major section.",
      );
      questions.push(`What is ${q}?`, `How do you choose ${q}?`);
      break;
    case "ctr_gap":
      strengthen.push(
        "Rewrite the title to 50-60 characters that state the concrete benefit.",
        "Rewrite the meta description to answer the query in one sentence and end with what the reader gets.",
        "Make the opening paragraph the snippet: the answer, then the reason.",
      );
      break;
    case "declining":
      strengthen.push(
        "Refresh every dated fact, price and example; state the current year where the copy dates itself.",
        `Check what now ranks for "${q}" and cover the angle it has that this page lacks.`,
        "Tighten the opening so the answer arrives in the first 90 words.",
      );
      questions.push(`What changed about ${q} this year?`);
      break;
    case "content_gap":
      if (headings.length && e.query && !headingMatchesQuery(headings, e.query)) {
        strengthen.push(`Add an H2 that uses the words of "${q}" and answers it in the section below.`);
      }
      if (e.word_count !== null && e.word_count < THRESHOLDS.contentGapWords) {
        strengthen.push(
          `Extend the thin sections with specifics: the page is ${e.word_count} words for a query that expects more depth.`,
        );
      }
      if (!strengthen.length) strengthen.push(`Cover "${q}" more fully in its own section.`);
      questions.push(`${q}: what does it involve?`, `Common mistakes with ${q}`);
      break;
    case "thin":
      strengthen.push(
        `Expand each section to actually answer its heading; the page is ${e.word_count ?? "under 600"} words.`,
        "Add a Key takeaways block after the opening paragraph.",
        "Add a comparison table if the topic compares anything.",
      );
      questions.push(`What is ${q}?`, `How much does ${q} cost?`, `Is ${q} worth it?`);
      break;
  }

  return {
    summary: `${OPPORTUNITY_LABELS[opportunity]}: ${describeEvidence(e).join("; ") || "no measurements"}.`,
    strengthen,
    questions,
    keep,
  };
}

/** The editable text form stored on the candidate. */
export function briefToText(b: Brief): string {
  const section = (title: string, items: string[]) =>
    items.length ? [`## ${title}`, ...items.map((i) => `- ${i}`)].join("\n") : "";
  return [
    b.summary.trim(),
    section("Strengthen", b.strengthen),
    section("Questions to answer", b.questions),
    section("Keep", b.keep),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Parse a model reply into a Brief. Tolerates a code fence and prose around
 * the JSON; returns null when nothing parseable is there, so the caller can
 * fall back rather than store garbage.
 */
export function parseBrief(text: string): Brief | null {
  const stripped = text.trim().replace(/^```[a-zA-Z]*\s*\n?/, "").replace(/\n?```\s*$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()) : [];
  const summary = typeof r.summary === "string" ? r.summary.trim() : "";
  const brief: Brief = {
    summary,
    strengthen: list(r.strengthen),
    questions: list(r.questions),
    keep: list(r.keep),
  };
  if (!brief.summary && !brief.strengthen.length && !brief.questions.length) return null;
  return brief;
}

export function buildBriefPrompt(input: BriefInput): { system: string; user: string } {
  const system = [
    "You are an editor planning the refresh of one existing web page. You will be given",
    "the reason the page was flagged, the Search Console evidence, and the page's current",
    "headings. Write a short, concrete plan for a rewrite.",
    "",
    "Output valid JSON only, no markdown fences, no prose around it, in this shape:",
    '{ "summary": "one sentence on what is wrong and what the rewrite should achieve",',
    '  "strengthen": ["3-5 specific instructions: which section, what to add or change"],',
    '  "questions": ["2-4 questions the page should answer that it does not, phrased as a reader types them"],',
    '  "keep": ["2-4 things the rewrite must not change"] }',
    "",
    "Rules: be specific to this page and this query; never invent statistics; do not suggest",
    "adding filler; every instruction must be checkable by reading the rewritten page.",
  ].join("\n");

  const user = [
    `URL: ${input.url}`,
    input.title ? `Current title: ${input.title}` : "",
    `Flagged as: ${OPPORTUNITY_LABELS[input.opportunity]}`,
    "",
    "Evidence:",
    ...describeEvidence(input.evidence).map((l) => `- ${l}`),
    "",
    input.headings.length ? "Current headings:" : "Current headings: (none available)",
    ...input.headings.slice(0, 30).map((h) => `- ${h}`),
  ]
    .filter((l) => l !== "")
    .join("\n");

  return { system, user };
}

export interface WriteBriefResult {
  brief: Brief;
  text: string;
  /** "model" when a model wrote it, "fallback" when the numbers did. */
  source: "model" | "fallback";
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
}

/**
 * Write the brief. One short structured call; falls back to the
 * deterministic plan when no key is configured or the reply does not parse.
 */
export async function writeBrief(input: BriefInput): Promise<WriteBriefResult> {
  const fallback = deterministicBrief(input);
  if (!process.env.ANTHROPIC_API_KEY) {
    return { brief: fallback, text: briefToText(fallback), source: "fallback" };
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = anthropicModel("structured");
  const { system, user } = buildBriefPrompt(input);
  const res = await client.messages.create({
    model,
    max_tokens: 1200,
    system,
    messages: [{ role: "user", content: user }],
  });
  const text = res.content[0]?.type === "text" ? res.content[0].text : "";
  const parsed = parseBrief(text);
  const brief = parsed
    ? { ...parsed, keep: parsed.keep.length ? parsed.keep : fallback.keep }
    : fallback;
  return {
    brief,
    text: briefToText(brief),
    source: parsed ? "model" : "fallback",
    inputTokens: res.usage?.input_tokens,
    outputTokens: res.usage?.output_tokens,
    model,
  };
}
