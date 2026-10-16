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
import { anthropicCost, anthropicEstimate, anthropicOutputRate, recordSpend } from "@/lib/billing/spend";
import { claimSpend, currentSpendScope, isBudgetRefusal } from "@/lib/billing/spend-scope";
import { recordSpendByDefault } from "@/lib/billing/default-spend";
import { BUDGET_RPC_TIMEOUT_MS, STRUCTURED_CALL_DEADLINE_MS } from "@/lib/onboarding/time-limits";

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
  /**
   * The least output the call is worth making with. Under a first look's
   * budget the call claims its most (`maxTokens`) when the room has it and
   * otherwise takes what the room has down to this floor, and is sent with
   * the output the grant covers - the article writer's rule (lib/ai/claude.ts).
   * Without it the claim is all of `maxTokens` or nothing: a reply that
   * costs a third of its ceiling was refused when the room held the reply
   * twice over (2026-10-15).
   */
  minTokens?: number;
  spend?: SpendSink | null;
  /** "decision" for the topic decisions (buyer fit, the results judge); the cheap structured tier otherwise. */
  tier?: "structured" | "decision";
  /**
   * The JSON schema the reply must follow (structured outputs). Sent for a
   * decision call (`DECISION_CALL.structuredOutput`); the prompt still says
   * the shape, so a replayed or schema-less answer parses the same way.
   */
  schema?: Record<string, unknown>;
  /**
   * How many leading characters of the prompt are the same on every call of
   * this kind in a run (instructions, before the per-call data). Sent as
   * their own block, marked for the prompt cache, so the calls after the
   * first read them at a tenth of the price. The text the model reads is
   * unchanged: the two blocks are the prompt, split in two.
   */
  cachePrefix?: number;
}

/**
 * The user message for `prompt`: one string, or the cached prefix and the
 * rest as two blocks when `cachePrefix` marks one.
 */
export function promptContent(prompt: string, cachePrefix?: number): string | Anthropic.TextBlockParam[] {
  if (!cachePrefix || cachePrefix <= 0 || cachePrefix >= prompt.length) return prompt;
  return [
    { type: "text", text: prompt.slice(0, cachePrefix), cache_control: { type: "ephemeral" } },
    { type: "text", text: prompt.slice(cachePrefix) },
  ];
}

/**
 * How long the calls after the first wait for it at most. A cache entry is
 * readable once the response that writes it has begun, not when it ends: by
 * then its prompt (here ~3,000 tokens) has been read. Waiting for the whole
 * answer would tie every other judge read, and the budget each pledged, to
 * the first: 4-9 seconds when it is well, its full deadline when it hangs.
 */
export const FIRST_CALL_HEAD_START_MS = 3_000;

/**
 * `ask`, with its first call given a head start: the calls that come while
 * it is out wait for its answer, or `headStartMs`, whichever comes first.
 * Made for prompts that share a cached prefix (`cachePrefix`): calls sent
 * together would each pay to write the same prefix, and a first look sends
 * up to fifteen judge reads at once.
 */
export function firstCallAlone(ask: AskModel, headStartMs: number = FIRST_CALL_HEAD_START_MS): AskModel {
  let first: Promise<unknown> | null = null;
  return async (operation, prompt, options) => {
    if (first) {
      await first;
      return ask(operation, prompt, options);
    }
    const call = ask(operation, prompt, options);
    let timer: ReturnType<typeof setTimeout> | undefined;
    first = Promise.race([
      call.catch(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, headStartMs); }),
    ]).finally(() => clearTimeout(timer));
    return call;
  };
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
 * How long one structured call may take, and how often it is retried. The
 * SDK's own default is ten minutes and two retries, half an hour for one
 * buyer-test batch, and a first look waits on every batch it sent: a call
 * the API never answered held the whole run silent. The longest structured
 * call measured is a 40-phrase buyer-test batch, well under a minute.
 */
export const STRUCTURED_TIMEOUT_MS = 120_000;
export const STRUCTURED_MAX_RETRIES = 1;

/**
 * What a structured call claims, and the output it is sent with for what it
 * was granted. The most is the prompt plus every output token allowed; the
 * floor is the prompt plus `minTokens`. Exported for tests.
 */
export function claimSize(model: string, promptChars: number, maxTokens: number, minTokens?: number): {
  wantUsd: number;
  minUsd: number;
  maxTokensFor: (grantedUsd: number) => number;
} {
  const inputUsd = anthropicEstimate(model, promptChars, 0);
  const perToken = anthropicOutputRate(model);
  const wantUsd = inputUsd + Math.max(0, maxTokens) * perToken;
  const floorTokens = minTokens === undefined ? maxTokens : Math.min(maxTokens, Math.max(1, minTokens));
  const minUsd = inputUsd + floorTokens * perToken;
  return {
    wantUsd,
    minUsd,
    // Granted whole (or outside a budget, where every claim is): the
    // ceiling. Granted less: what the grant pays for, never below the floor
    // it was granted at.
    maxTokensFor: (grantedUsd) => grantedUsd >= wantUsd - 1e-12
      ? maxTokens
      : Math.max(floorTokens, Math.min(maxTokens, Math.floor((grantedUsd - inputUsd) / perToken))),
  };
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
  const sized = claimSize(model, prompt.length + JSON.stringify(options.schema ?? "").length, options.maxTokens, options.minTokens);
  try {
    claim = await claimSpend(operation, sized.wantUsd, { minUsd: sized.minUsd });
  } catch (err) {
    if (isBudgetRefusal(err)) {
      console.warn(`[${operation}] not asked: ${err.message}`);
      return null;
    }
    throw err;
  }
  let cost: number | null = 0;
  try {
    const client = new Anthropic({ apiKey, timeout: STRUCTURED_TIMEOUT_MS, maxRetries: STRUCTURED_MAX_RETRIES });
    // The SDK's timeout ends when the reply's headers arrive (client.js
    // `fetchWithTimeout` clears it), so a body that never came held the call,
    // its claim and whatever waited on it for good (2026-10-15). The signal
    // bounds all of it: both attempts, the backoff and the reply.
    const response = await client.messages.create({
      model,
      max_tokens: sized.maxTokensFor(claim.grantedUsd),
      messages: [{ role: "user", content: promptContent(prompt, options.cachePrefix) }],
      ...samplingFor(model, options.tier, options.schema),
    } as Anthropic.MessageCreateParamsNonStreaming, { signal: AbortSignal.timeout(STRUCTURED_CALL_DEADLINE_MS) });
    const uncached = response.usage?.input_tokens ?? 0;
    const writeTokens = response.usage?.cache_creation_input_tokens ?? 0;
    const readTokens = response.usage?.cache_read_input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    cost = anthropicCost(model, uncached, outputTokens, { writeTokens, readTokens });
    // The row counts every input token the call read, cached or not; its
    // cost is what the cache made of them.
    const inputTokens = uncached + writeTokens + readTokens;
    const entry = { provider: "anthropic" as const, operation, costUsd: cost, inputTokens, outputTokens };
    // With no sink, a call inside a spend scope is still written (with the
    // operator's client); outside one, scripts and tests write nothing. The
    // row is waited for at most BUDGET_RPC_TIMEOUT_MS: the claim settles
    // after it, and a paid answer is not lost to a slow write.
    if (options.spend) await atMost(recordSpend(options.spend.supabase, { ...entry, workspaceId: options.spend.workspaceId }), BUDGET_RPC_TIMEOUT_MS);
    else if (currentSpendScope()) recordSpendByDefault(entry);
    return replyText(response.content);
  } catch (err) {
    // A call that ran out of time may still have been run and billed: its
    // claim stays at the estimate, as a timed-out DataForSEO request's does
    // (lib/seo/client.ts). Anything else answered with an error.
    if (timedOut(err)) cost = null;
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

/** An aborted or timed-out request: the SDK's own timeout, or the deadline's signal. */
function timedOut(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "APIConnectionTimeoutError" || name === "APIUserAbortError" || name === "AbortError" || name === "TimeoutError";
}

/** Wait for `work`, but no longer than `ms`; what it does after that is not waited for. */
function atMost(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
  ]).finally(() => clearTimeout(timer));
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
  competitorNames?: string[] | null;
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
  // Named by the owner with no website found: names, never hosts.
  if (business.competitorNames?.length) lines.push(`Competitors named by the owner (no website): ${business.competitorNames.join(", ")}`);
  if (business.buyingJobs?.length) lines.push(`Buying jobs: ${business.buyingJobs.join("; ")}`);
  if (business.differentiators?.length) lines.push(`Supported differences: ${business.differentiators.join("; ")}`);
  if (business.exclusions?.length) lines.push(`Not served: ${business.exclusions.join("; ")}`);
  if (business.conversionUrl) lines.push(`Conversion page: ${business.conversionUrl}`);
  if (business.language) lines.push(`Language: ${business.language}`);
  if (business.country) lines.push(`Market: ${business.country}`);
  return lines.join("\n");
}
