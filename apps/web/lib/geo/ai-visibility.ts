// ---------------------------------------------------------------------------
// AI visibility: is this brand cited when an AI answers the buying question?
// ---------------------------------------------------------------------------
//
// The product could measure whether a site is *readable* by agents and could
// generate content for it, but nothing measured whether any of it worked. Agent
// readiness is an input; being named in the answer is the outcome. Without this
// half, the GEO claim rests on a proxy.
//
// Runs through DataForSEO's AI Optimization endpoints rather than the model
// vendors directly. Three reasons: the credentials are already paid for, one
// account covers ChatGPT, Claude, Gemini and Perplexity behind one contract,
// and the responses come back with citation annotations already extracted,
// which is the expensive part to do reliably from raw model output.
//
// COST. A web-search answer costs roughly 60x a plain completion ($0.066 versus
// $0.001 measured). Ten prompts across four engines is a couple of dollars per
// run, so every entry point here is bounded and explicitly opted into. This is
// the most expensive thing the product can do on a schedule.

import { post } from "@/lib/seo/client";

export type AiEngine = "chat_gpt" | "claude" | "gemini" | "perplexity";

export const AI_ENGINES: AiEngine[] = ["chat_gpt", "claude", "gemini", "perplexity"];

export interface AiCitation {
  title: string;
  url: string;
  domain: string;
}

export interface VisibilityProbe {
  prompt: string;
  engine: AiEngine;
  model: string;
}

export interface VisibilityResult {
  prompt: string;
  engine: AiEngine;
  model: string;
  answer: string;
  /** The brand name appears in the answer text. */
  mentioned: boolean;
  /** The brand's own domain appears in the citations. */
  cited: boolean;
  citations: AiCitation[];
  /** Cited domains that are not the brand's own. */
  competitorDomains: string[];
  /** The searches the model ran to ground its answer. */
  fanOutQueries: string[];
  costUsd: number;
  error?: string;
}

interface RawSection {
  text?: string;
  annotations?: Array<{ title?: string; url?: string }>;
}

interface RawLlmResult {
  model_name?: string;
  web_search?: boolean;
  money_spent?: number;
  fan_out_queries?: string[];
  items?: Array<{ sections?: RawSection[] }>;
}

/** Strip to a registrable-ish host so "www.x.com" and "x.com/a" compare equal. */
export function toDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Does the answer name this brand?
 *
 * Word-boundary matched so "Alto" does not fire on "Palo Alto" and a two-letter
 * brand does not match half the alphabet. Case-insensitive because models
 * reformat capitalisation freely.
 */
export function mentionsBrand(text: string, brand: string): boolean {
  const needle = brand.trim();
  if (needle.length < 2) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, "iu").test(text);
}

/**
 * Ask one engine one question and record whether the brand shows up.
 *
 * Never throws: a visibility sweep across several engines should not lose the
 * engines that answered because one refused. A failed probe returns with
 * `error` set and counts as "not visible" nowhere, it is simply excluded.
 */
export async function probeVisibility(options: {
  probe: VisibilityProbe;
  brandName: string;
  brandDomain: string;
  maxOutputTokens?: number;
}): Promise<VisibilityResult> {
  const { probe, brandName, brandDomain, maxOutputTokens = 700 } = options;
  const ownDomain = brandDomain.replace(/^https?:\/\//, "").replace(/^www\./, "").toLowerCase();

  const base: VisibilityResult = {
    prompt: probe.prompt,
    engine: probe.engine,
    model: probe.model,
    answer: "",
    mentioned: false,
    cited: false,
    citations: [],
    competitorDomains: [],
    fanOutQueries: [],
    costUsd: 0,
  };

  try {
    const response = await post<RawLlmResult>(
      `/ai_optimization/${probe.engine}/llm_responses/live`,
      [
        {
          user_prompt: probe.prompt,
          model_name: probe.model,
          max_output_tokens: maxOutputTokens,
          // Without web search the model answers from training data and cites
          // nothing, which measures its memory rather than the live answer a
          // buyer would see.
          web_search: true,
        },
      ],
    );

    const result = response.tasks?.[0]?.result?.[0];
    if (!result) return { ...base, error: "no result returned" };

    const answerParts: string[] = [];
    const citations: AiCitation[] = [];

    for (const item of result.items ?? []) {
      for (const section of item.sections ?? []) {
        if (section.text) answerParts.push(section.text);
        for (const a of section.annotations ?? []) {
          if (!a.url) continue;
          const domain = toDomain(a.url);
          if (!domain) continue;
          citations.push({ title: a.title ?? "", url: a.url, domain });
        }
      }
    }

    const answer = answerParts.join("\n\n");
    const cited = citations.some((c) => c.domain === ownDomain || c.domain.endsWith(`.${ownDomain}`));

    const competitorDomains = [
      ...new Set(
        citations
          .map((c) => c.domain)
          .filter((d) => d !== ownDomain && !d.endsWith(`.${ownDomain}`)),
      ),
    ];

    return {
      ...base,
      answer,
      mentioned: mentionsBrand(answer, brandName),
      cited,
      citations,
      competitorDomains,
      fanOutQueries: result.fan_out_queries ?? [],
      costUsd: result.money_spent ?? response.cost ?? 0,
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : "probe failed" };
  }
}

export interface VisibilitySummary {
  probesRun: number;
  probesFailed: number;
  /** Share of successful probes whose answer named the brand. */
  mentionRate: number;
  /** Share of successful probes that cited the brand's own domain. */
  citationRate: number;
  /** Cited domains ranked by how often they appear, brand excluded. */
  topCompetitors: Array<{ domain: string; citations: number; shareOfVoice: number }>;
  totalCostUsd: number;
}

/**
 * Roll probes up into the numbers a client actually asks about.
 *
 * Rates are computed over probes that succeeded, not over probes attempted. An
 * engine timing out is missing data, and counting it as "not mentioned" would
 * quietly report a worse position than the evidence supports, which is the
 * class of mistake this codebase keeps having to undo.
 */
export function summariseVisibility(results: VisibilityResult[]): VisibilitySummary {
  const ok = results.filter((r) => !r.error);
  const failed = results.length - ok.length;

  const domainCounts = new Map<string, number>();
  for (const r of ok) {
    for (const d of r.competitorDomains) {
      domainCounts.set(d, (domainCounts.get(d) ?? 0) + 1);
    }
  }

  const totalCompetitorCitations = [...domainCounts.values()].reduce((a, b) => a + b, 0);

  const topCompetitors = [...domainCounts.entries()]
    .map(([domain, citations]) => ({
      domain,
      citations,
      shareOfVoice: totalCompetitorCitations
        ? Math.round((citations / totalCompetitorCitations) * 1000) / 10
        : 0,
    }))
    .sort((a, b) => b.citations - a.citations)
    .slice(0, 15);

  const rate = (n: number) => (ok.length ? Math.round((n / ok.length) * 1000) / 10 : 0);

  return {
    probesRun: ok.length,
    probesFailed: failed,
    mentionRate: rate(ok.filter((r) => r.mentioned).length),
    citationRate: rate(ok.filter((r) => r.cited).length),
    topCompetitors,
    totalCostUsd: Math.round(results.reduce((s, r) => s + r.costUsd, 0) * 10000) / 10000,
  };
}

/**
 * Models that support web search, per engine.
 *
 * Pinned rather than fetched per run: the model list is a paid call, changes
 * rarely, and a sweep should not silently switch models between runs because
 * that makes the trend line meaningless. Verified against the live
 * `/llm_responses/models` endpoint.
 */
export const DEFAULT_MODELS: Record<AiEngine, string> = {
  chat_gpt: "gpt-4.1",
  claude: "claude-sonnet-4-5",
  gemini: "gemini-2.5-flash",
  perplexity: "sonar",
};
