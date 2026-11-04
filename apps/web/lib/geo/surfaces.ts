// ---------------------------------------------------------------------------
// The answer surfaces a buyer actually uses, as one queued task each
// ---------------------------------------------------------------------------
//
// Until 2026-11-04 the tracker asked the model vendors' APIs (DataForSEO
// llm_responses): web search forced on, the answer capped at 700 tokens, and
// Gemini's API standing in for Google's AI answers. That measures a model, not
// the ChatGPT app or Google AI Mode a buyer types into, and at $0.066 an answer
// it could afford one sample per cell, which cannot tell 0% from 9%.
//
// These scrape the consumer products themselves: DataForSEO's LLM Scraper for
// the ChatGPT and Gemini apps, and its AI Mode SERP for Google. On the standard
// queue each is $0.0012 a task (checked 2026-11-04 on dataforseo.com/pricing),
// fifty times cheaper per answer, which is what makes sampling affordable.
// ChatGPT decides for itself whether to search, as it does for a buyer, so
// `force_web_search` is left off. Claude and Perplexity have no consumer
// scraper there, and are not measured rather than measured through an API that
// would be reported as if it were the product.

import type { AiCitation, AiEngine } from "./ai-visibility";
import { toDomain } from "./ai-visibility";

export type GeoSurface = Extract<AiEngine, "chat_gpt" | "gemini" | "google_ai_mode">;

export const GEO_SURFACES: readonly GeoSurface[] = ["chat_gpt", "gemini", "google_ai_mode"];

const BASE: Record<GeoSurface, string> = {
  chat_gpt: "/ai_optimization/chat_gpt/llm_scraper",
  gemini: "/ai_optimization/gemini/llm_scraper",
  google_ai_mode: "/serp/google/ai_mode",
};

export const taskPostPath = (surface: GeoSurface) => `${BASE[surface]}/task_post`;
export const taskGetPath = (surface: GeoSurface, taskId: string) => `${BASE[surface]}/task_get/advanced/${taskId}`;

/** One task, as DataForSEO's task_post takes it. */
export function buildTask(options: {
  prompt: string;
  languageCode: string;
  locationCode: number;
  tag: string;
}): Record<string, unknown> {
  return {
    keyword: options.prompt,
    language_code: options.languageCode,
    location_code: options.locationCode,
    // 1 is the standard queue. 2 doubles the price for a minute's speed,
    // and nothing here is waiting.
    priority: 1,
    tag: options.tag,
  };
}

/** What one collected answer says, whichever surface it came from. */
export interface SurfaceAnswer {
  model: string;
  answer: string;
  citations: AiCitation[];
  /** Brands the surface itself reported as named (the ChatGPT app does). */
  brands: string[];
  fanOutQueries: string[];
}

interface RawSource {
  url?: string | null;
  domain?: string | null;
  title?: string | null;
}

interface RawScraperResult {
  model?: string | null;
  markdown?: string | null;
  sources?: RawSource[] | null;
  fan_out_queries?: string[] | null;
  brand_entities?: Array<{ title?: string | null }> | null;
}

interface RawAiModeNode {
  type?: string;
  markdown?: string | null;
  references?: RawSource[] | null;
  links?: RawSource[] | null;
  items?: RawAiModeNode[] | null;
}

interface RawAiModeResult {
  items?: RawAiModeNode[] | null;
}

function citationsFrom(sources: Iterable<RawSource>): AiCitation[] {
  const seen = new Set<string>();
  const out: AiCitation[] = [];
  for (const s of sources) {
    if (!s.url) continue;
    const domain = (s.domain ?? "").replace(/^www\./, "").toLowerCase() || toDomain(s.url);
    if (!domain || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push({ title: s.title ?? "", url: s.url, domain });
  }
  return out;
}

/** Every reference and link anywhere under an AI Mode answer. */
function* aiModeSources(node: RawAiModeNode): Generator<RawSource> {
  for (const r of node.references ?? []) yield r;
  for (const l of node.links ?? []) yield l;
  for (const child of node.items ?? []) yield* aiModeSources(child);
}

/**
 * Read one task_get result into an answer. Null when the surface returned no
 * answer at all: AI Mode can answer a query with no AI block, and that is a
 * failed sample, not an answer that named nobody.
 */
export function parseSurfaceResult(surface: GeoSurface, result: unknown): SurfaceAnswer | null {
  if (!result || typeof result !== "object") return null;

  if (surface === "google_ai_mode") {
    const blocks = ((result as RawAiModeResult).items ?? []).filter((i) => i.type === "ai_overview");
    const answer = blocks.map((b) => b.markdown ?? "").join("\n\n").trim();
    if (!answer) return null;
    return {
      model: "ai_mode",
      answer,
      citations: citationsFrom(blocks.flatMap((b) => [...aiModeSources(b)])),
      brands: [],
      fanOutQueries: [],
    };
  }

  const r = result as RawScraperResult;
  const answer = (r.markdown ?? "").trim();
  if (!answer) return null;
  return {
    model: r.model || surface,
    answer,
    citations: citationsFrom(r.sources ?? []),
    brands: [
      ...new Set((r.brand_entities ?? []).map((b) => (b.title ?? "").trim()).filter(Boolean)),
    ],
    fanOutQueries: r.fan_out_queries ?? [],
  };
}

/**
 * DataForSEO's "not ready yet" task statuses: 40601 Task Handed, 40602 Task in
 * Queue. Anything else that is not a success is final for that task.
 */
export function isStillQueued(statusCode: number): boolean {
  return statusCode === 40601 || statusCode === 40602;
}
