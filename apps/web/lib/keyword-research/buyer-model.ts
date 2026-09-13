import { supportedCapabilities, type BusinessFocus } from "@/lib/onboarding/profile-focus";
import { providerSignal, currentResearchBudget } from "@/lib/seo/request-context";
// ---------------------------------------------------------------------------
// The one model call shape the buyer-side research makes, and its bill
// ---------------------------------------------------------------------------
//
// Both calls in this family (`buyer-seeds.ts`, `buyer-fit.ts`) are short,
// structured, and on the cheap tier. They share the client, the "no key means
// no call" rule, the JSON extraction, and the spend row, so neither can forget
// to bill and neither parses the reply its own way.

import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anthropicModel, type ModelTier } from "@/lib/ai/models";
import { anthropicCost, recordSpend } from "@/lib/billing/spend";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

/** Where to write the spend row. Optional: scripts and tests have none. */
export interface SpendSink {
  supabase: SupabaseClient;
  workspaceId: string | null;
}

export interface ModelObservation {
  operation: string; model: string; elapsedMs: number;
  status: "complete" | "truncated" | "deadline" | "unavailable";
  inputTokens?: number; outputTokens?: number; costUsd?: number | null;
  thinking?: "disabled" | "adaptive-medium" | "default";
  promptHash?: string;
  /** Present only for an explicitly enabled offline observer, never spend rows. */
  responseText?: string;
}
export interface StructuredOptions {
  maxTokens: number; spend?: SpendSink | null; tier?: ModelTier;
  schema?: Record<string, unknown>;
  observe?: (event: ModelObservation) => void;
}
const observations = new AsyncLocalStorage<{observer:(event:ModelObservation)=>void;includeResponse:boolean}>();
/** Offline evaluations observe the real helper without replacing provider calls. */
export function withModelObserver<T>(observer: (event: ModelObservation) => void, work: () => T, options: {includeResponse?:boolean} = {}): T {
  return observations.run({observer,includeResponse:options.includeResponse??false}, work);
}

export function modelAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * One structured call. Returns the text of the reply, or null when there is
 * no key or the call failed. Callers preserve the missing decision; automatic
 * writing must never interpret it as approval.
 */
export async function askStructured(
  operation: string,
  prompt: string,
  options: StructuredOptions,
): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const model = anthropicModel(options.tier ?? "structured");
  // Unbounded default thinking exhausted review output; fully disabling it
  // missed a real comparison error. Full-article judgments use measured medium
  // effort; short final-topic checks stay non-thinking. Content is separate.
  const editorial = options.tier === "editorial";
  const reasoning = process.env.ANTHROPIC_EDITORIAL_REASONING ?? (operation.startsWith("article/") ? "medium" : "disabled");
  const mediumThinking = editorial && reasoning === "medium" && /^claude-(?:sonnet-5|opus-5|sonnet-4-6|opus-4-[6-8])/.test(model);
  const started = Date.now();
  // Observability must never turn a valid model result into a failed request.
  const observe = (event: Omit<ModelObservation, "operation" | "model" | "elapsedMs">, responseText?:string) => {
    const observation = { operation, model, thinking: mediumThinking ? "adaptive-medium" as const : editorial ? "disabled" as const : "default" as const, promptHash:createHash("sha256").update(prompt).digest("hex"), elapsedMs: Date.now() - started, ...event };
    try {
      options.observe?.(observation);
      const context=observations.getStore();
      context?.observer({...observation,...(context.includeResponse?{responseText}: {})});
    } catch { /* Best effort observer. */ }
  };
  try {
    const client = new Anthropic({ apiKey, maxRetries: 0 });
    const response = await client.messages.create({
      model,
      max_tokens: options.maxTokens,
      ...(mediumThinking ? {thinking:{type:"adaptive" as const}} : editorial ? {thinking:{type:"disabled" as const}} : {}),
      ...((mediumThinking || options.schema) ? {output_config:{...(mediumThinking?{effort:"medium" as const}:{}),...(options.schema?{format:{type:"json_schema" as const,schema:options.schema}}:{})}} : {}),
      messages: [{ role: "user", content: prompt }],
    }, { signal: providerSignal(options.tier === "editorial" ? 60_000 : 25_000) });
    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    const cost = anthropicCost(model, inputTokens, outputTokens);
    const budget = currentResearchBudget();
    if (budget) budget.costUsd += cost ?? 0;
    if (options.spend) {
      await boundedAccounting(recordSpend(options.spend.supabase, {
        provider: "anthropic",
        operation,
        costUsd: cost,
        inputTokens,
        outputTokens,
        workspaceId: options.spend.workspaceId,
      }));
    }
    const status = response.stop_reason === "max_tokens" ? "truncated" : "complete";
    const text = response.content.filter(b => b.type === "text").map(b => b.text).join("");
    observe({ status, inputTokens, outputTokens, costUsd: cost }, text);
    if (status === "truncated") return null;
    return text || null;
  } catch (error) {
    const name = (error as { name?: string })?.name;
    observe({ status: name === "TimeoutError" || name === "AbortError" || name === "APIUserAbortError" || name === "ResearchBudgetError" ? "deadline" : "unavailable" });
    return null;
  }
}

/**
 * The JSON value inside a reply that may carry prose or a code fence around
 * it. `open`/`close` pick the bracket pair: "[" and "]" for an array reply.
 */
export function extractJson<T>(raw: string | null, open: "[" | "{", close: "]" | "}"): T | null {
  if (!raw) return null;
  const start = raw.indexOf(open);
  const end = raw.lastIndexOf(close);
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/** The lines of a business profile the prompts share. */
export function describeBusiness(business: BusinessFocus & {
  name?: string | null;
  description?: string | null;
  audiences?: string[] | null;
  offerings?: string[] | null;
  competitors?: string[] | null;
  buyingJobs?: string[] | null;
  differentiators?: string[] | null;
  exclusions?: string[] | null;
  conversionUrl?: string | null;
  country?: string | null;
  language?: string | null;
}): string {
  const lines: string[] = [];
  if (business.primaryBuyer) lines.push(`FIRST priority buyer: ${business.primaryBuyer}`);
  if (business.priorityOffering) lines.push(`FIRST priority offering: ${business.priorityOffering}`);
  lines.push(`Supported product capabilities: ${JSON.stringify(supportedCapabilities(business))}`);
  if (business.name?.trim()) lines.push(`Name: ${business.name.trim()}`);
  if (business.description?.trim()) lines.push(`What it does: ${business.description.trim()}`);
  if (business.offerings?.length) lines.push(`What people buy from it: ${business.offerings.join("; ")}`);
  if (business.audiences?.length) lines.push(`Who buys: ${business.audiences.join("; ")}`);
  if (business.competitors?.length) lines.push(`Competitors: ${business.competitors.join(", ")}`);
  if (business.buyingJobs?.length) lines.push(`Buying jobs: ${business.buyingJobs.join("; ")}`);
  if (business.differentiators?.length) lines.push(`Site positioning (not independently verified capabilities): ${business.differentiators.join("; ")}`);
  if (business.exclusions?.length) lines.push(`Not served: ${business.exclusions.join("; ")}`);
  if (business.conversionUrl) lines.push(`Conversion page: ${business.conversionUrl}`);
  if (business.language) lines.push(`Language: ${business.language}`);
  if (business.country) lines.push(`Market: ${business.country}`);
  return lines.join("\n");
}

/** A slow accounting database cannot discard a successful model response. */
async function boundedAccounting(work: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work.catch(() => { console.error("[research] Spend recording failed"); }),
      new Promise<void>((resolve) => { timer = setTimeout(() => { console.error("[research] Spend recording exceeded deadline"); resolve(); }, 1500); })]);
  } finally { clearTimeout(timer); }
}
