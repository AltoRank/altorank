// ---------------------------------------------------------------------------
// One Anthropic call, claimed before and billed after
// ---------------------------------------------------------------------------
//
// The voice read and the site's profile inference made their model calls with
// nothing around them: no spend row, so a first look's bill was short by
// whatever they cost, and no claim, so a budget could not stop them. This is
// the wrapper for a plain `messages.create`: under a first look's budget it
// claims the call's most before sending (lib/billing/spend-scope.ts) and
// throws BudgetRefusedError when that is not covered; it writes the spend row
// with the scope's attribution, or unattributed outside one, and settles the
// claim with the real price.

import type Anthropic from "@anthropic-ai/sdk";
import { anthropicCost, anthropicEstimate } from "@/lib/billing/spend";
import { recordSpendByDefault } from "@/lib/billing/default-spend";
import { claimSpend } from "@/lib/billing/spend-scope";
import { METERED_CALL_DEADLINE_MS } from "@/lib/onboarding/time-limits";

export async function createMetered(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  operation: string,
): Promise<Anthropic.Message> {
  const promptChars = JSON.stringify(params.system ?? "").length + JSON.stringify(params.messages).length;
  const claim = await claimSpend(operation, anthropicEstimate(params.model, promptChars, params.max_tokens));
  let cost: number | null = 0;
  try {
    // Bounded end to end: the SDK's own timeout stops when the headers come,
    // and the voice read is awaited before a first look's plan.
    const response = await client.messages.create(params, { signal: AbortSignal.timeout(METERED_CALL_DEADLINE_MS) });
    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    cost = anthropicCost(params.model, inputTokens, outputTokens);
    recordSpendByDefault({ provider: "anthropic", operation, costUsd: cost, inputTokens, outputTokens });
    return response;
  } catch (err) {
    // Out of time, it may still have been billed: the claim keeps its estimate.
    const name = (err as { name?: unknown } | null)?.name;
    if (name === "APIConnectionTimeoutError" || name === "APIUserAbortError" || name === "AbortError" || name === "TimeoutError") cost = null;
    throw err;
  } finally {
    await claim.settle(cost);
  }
}

/**
 * The same for a streamed call: claimed before, billed after, and billed for
 * what was generated even when it stops part-way. The provider charges for
 * every token it produced before a stop - a reader that went away, a token
 * ceiling, an error mid-stream - so the row is written from the usage the
 * stream reported so far rather than only from a finished message.
 *
 * The API reports the output count once, at the end (`message_delta`): a
 * stream stopped before then has reported one output token however much it
 * wrote. So a stream that did not finish is billed for at least the text it
 * delivered, counted at STOPPED_CHARS_PER_TOKEN, a rate that errs high like
 * the claim's estimate rather than low.
 *
 * `onText` gets each piece of text as it arrives. The final message is
 * returned; anything thrown (by the stream or by `onText`) is thrown on after
 * the row is written.
 */
/** Characters per output token for a stream stopped before it reported its count: errs high, like anthropicEstimate. */
export const STOPPED_CHARS_PER_TOKEN = 2.5;

export async function streamMetered(
  client: Anthropic,
  params: Anthropic.MessageStreamParams,
  operation: string,
  onText: (text: string) => void,
  opts: { signal?: AbortSignal } = {},
): Promise<Anthropic.Message> {
  const promptChars = JSON.stringify(params.system ?? "").length + JSON.stringify(params.messages).length;
  const claim = await claimSpend(operation, anthropicEstimate(params.model, promptChars, params.max_tokens));
  let inputTokens = 0;
  let outputTokens = 0;
  let textChars = 0;
  let finished = false;
  let cost: number | null = null;
  try {
    const run = client.messages.stream(params, opts.signal ? { signal: opts.signal } : undefined);
    for await (const event of run) {
      if (event.type === "message_start") {
        inputTokens = event.message.usage?.input_tokens ?? inputTokens;
        outputTokens = event.message.usage?.output_tokens ?? outputTokens;
      } else if (event.type === "message_delta") {
        // Cumulative, per the API: the latest is the total so far.
        outputTokens = event.usage?.output_tokens ?? outputTokens;
      } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        textChars += event.delta.text.length;
        onText(event.delta.text);
      }
    }
    const final = await run.finalMessage();
    inputTokens = final.usage?.input_tokens ?? inputTokens;
    outputTokens = final.usage?.output_tokens ?? outputTokens;
    finished = true;
    return final;
  } finally {
    if (!finished) outputTokens = Math.max(outputTokens, Math.ceil(textChars / STOPPED_CHARS_PER_TOKEN));
    // A stream that never started bought nothing: no row. One that did is
    // written with what it reported, which is what was billed.
    if (inputTokens > 0 || outputTokens > 0) {
      cost = anthropicCost(params.model, inputTokens, outputTokens);
      recordSpendByDefault({ provider: "anthropic", operation, costUsd: cost, inputTokens, outputTokens });
    }
    await claim.settle(cost);
  }
}
