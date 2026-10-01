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
import { acceptsThinkingDisabled, anthropicModel, DECISION_CALL, refusesTemperature, replyText } from "@/lib/ai/models";
import { anthropicCost, anthropicEstimate, recordSpend } from "@/lib/billing/spend";
import { claimSpend, currentSpendScope, isBudgetRefusal } from "@/lib/billing/spend-scope";
import { recordSpendByDefault } from "@/lib/billing/default-spend";

/** Where to write the spend row. Optional: scripts and tests have none. */
export interface SpendSink {
  supabase: SupabaseClient;
  workspaceId: string | null;
}

/**
 * How one structured call is made: `askStructured`'s signature. Production
 * passes nothing and gets `askStructured`; the decision evals (lib/evals)
 * pass a recorder that replays stored answers, so they run the same prompt
 * builders and parsers against real cases for free.
 */
export type AskModel = (operation: string, prompt: string, options: AskOptions) => Promise<string | null>;

export interface AskOptions {
  maxTokens: number;
  spend?: SpendSink | null;
  /** "decision" for the topic decisions (buyer fit, the results judge); the cheap structured tier otherwise. */
  tier?: "structured" | "decision";
  /**
   * The JSON schema the reply must follow (structured outputs). Sent for a
   * decision call (`DECISION_CALL.structuredOutput`); the prompt still says
   * the shape, so a replayed or schema-less answer parses the same way.
   */
  schema?: Record<string, unknown>;
}

/**
 * The request parameters a call is made with, beyond the model, prompt and
 * token cap: `DECISION_CALL` (lib/ai/models.ts) for a decision, temperature
 * 0 alone for the cheap tier. Temperature 0 where the model takes one;
 * thinking off; the reply constrained to `schema` when one is given.
 */
export function samplingFor(model: string, tier: AskOptions["tier"], schema?: Record<string, unknown>): Record<string, unknown> {
  // The cheap tier (buyer seeds, rival vetting) proposes what the judges are
  // then asked about: at temperature 0 too, where the model takes one, so two
  // first looks of one site start from the same seeds and the same rivals.
  if (tier !== DECISION_CALL.tier) return refusesTemperature(model) ? {} : { temperature: 0 };
  const out: Record<string, unknown> = refusesTemperature(model)
    ? (acceptsThinkingDisabled(model) ? { thinking: { type: DECISION_CALL.thinking } } : {})
    : { temperature: DECISION_CALL.temperature };
  if (DECISION_CALL.structuredOutput && schema) out.output_config = { format: { type: "json_schema", schema } };
  return out;
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
  options: AskOptions,
): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const model = anthropicModel(options.tier ?? "structured");
  // A first look claims the call's most before making it
  // (lib/billing/spend-scope.ts). A refusal is no decision, like any other
  // missing answer, and the caller's watch on the scope sees it was refused.
  let claim: Awaited<ReturnType<typeof claimSpend>>;
  try {
    claim = await claimSpend(operation, anthropicEstimate(model, prompt.length + JSON.stringify(options.schema ?? "").length, options.maxTokens));
  } catch (err) {
    if (isBudgetRefusal(err)) {
      console.warn(`[${operation}] not asked: ${err.message}`);
      return null;
    }
    throw err;
  }
  let cost: number | null = 0;
  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model,
      max_tokens: options.maxTokens,
      messages: [{ role: "user", content: prompt }],
      ...samplingFor(model, options.tier, options.schema),
    } as Anthropic.MessageCreateParamsNonStreaming);
    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    cost = anthropicCost(model, inputTokens, outputTokens);
    const entry = { provider: "anthropic" as const, operation, costUsd: cost, inputTokens, outputTokens };
    // With no sink, a call inside a spend scope is still written (with the
    // operator's client); outside one, scripts and tests write nothing.
    if (options.spend) await recordSpend(options.spend.supabase, { ...entry, workspaceId: options.spend.workspaceId });
    else if (currentSpendScope()) recordSpendByDefault(entry);
    return replyText(response.content);
  } catch (err) {
    // Still no decision, never an approval; but a model the account cannot
    // use, or a parameter it refuses, fails every call the same way, and a
    // silent null made that look like "the model had no answer" (review,
    // 2026-09-30). Said once per call, with the status and the model.
    const status = (err as { status?: unknown } | null)?.status;
    console.warn(`[${operation}] ${model} call failed${typeof status === "number" ? ` (${status})` : ""}: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
    return null;
  } finally {
    await claim.settle(cost);
  }
}

/**
 * The JSON value inside a reply that may carry prose, a code fence or
 * reasoning around it. `open`/`close` pick the bracket pair: "[" and "]" for
 * an array reply.
 *
 * A model asked with thinking switched off may still reason first, in its
 * visible text ("<think>1. \"phrase\" - ...</think>" then the answer; Sonnet 5,
 * 2026-09-30): the first bracket is then inside the reasoning and the whole
 * batch was lost as "no decision". So the answer is looked for after the
 * reasoning, in a fenced block, and from the last line that opens one.
 */
export function extractJson<T>(raw: string | null, open: "[" | "{", close: "]" | "}"): T | null {
  if (!raw) return null;
  const candidates: string[] = [raw];
  const thought = raw.lastIndexOf("</think>");
  if (thought !== -1) candidates.push(raw.slice(thought + "</think>".length));
  for (const fence of [...raw.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].reverse()) candidates.push(fence[1]);
  const lineStarts = [...raw.matchAll(new RegExp(`(^|\\n)\\s*\\${open}`, "g"))].map((m) => (m.index ?? 0) + m[0].length - 1).reverse();
  for (const at of lineStarts) candidates.push(raw.slice(at));
  for (const text of candidates) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(text.slice(start, end + 1)) as T;
    } catch {
      // try the next place the answer could start
    }
  }
  return null;
}

/** The lines of a business profile the prompts share. */
export function describeBusiness(business: {
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
  if (business.name?.trim()) lines.push(`Name: ${business.name.trim()}`);
  if (business.description?.trim()) lines.push(`What it does: ${business.description.trim()}`);
  if (business.offerings?.length) lines.push(`What people buy from it: ${business.offerings.join("; ")}`);
  if (business.audiences?.length) lines.push(`Who buys: ${business.audiences.join("; ")}`);
  if (business.competitors?.length) lines.push(`Competitors: ${business.competitors.join(", ")}`);
  if (business.buyingJobs?.length) lines.push(`Buying jobs: ${business.buyingJobs.join("; ")}`);
  if (business.differentiators?.length) lines.push(`Supported differences: ${business.differentiators.join("; ")}`);
  if (business.exclusions?.length) lines.push(`Not served: ${business.exclusions.join("; ")}`);
  if (business.conversionUrl) lines.push(`Conversion page: ${business.conversionUrl}`);
  if (business.language) lines.push(`Language: ${business.language}`);
  if (business.country) lines.push(`Market: ${business.country}`);
  return lines.join("\n");
}
