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

export async function createMetered(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  operation: string,
): Promise<Anthropic.Message> {
  const promptChars = JSON.stringify(params.system ?? "").length + JSON.stringify(params.messages).length;
  const claim = await claimSpend(operation, anthropicEstimate(params.model, promptChars, params.max_tokens));
  let cost: number | null = 0;
  try {
    const response = await client.messages.create(params);
    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    cost = anthropicCost(params.model, inputTokens, outputTokens);
    recordSpendByDefault({ provider: "anthropic", operation, costUsd: cost, inputTokens, outputTokens });
    return response;
  } finally {
    await claim.settle(cost);
  }
}
