import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Recording what a run cost
// ---------------------------------------------------------------------------
//
// Every DataForSEO response reports `cost` and every Anthropic response reports
// its token counts. Both were thrown away everywhere except the GEO probes, so
// the product could not answer the question its own pricing rests on: at 30
// articles a month, does EUR 99 cover the bill?
//
// Recording is deliberately best-effort. A failure to log what something cost
// must never fail the thing itself - losing a generated article to a bookkeeping
// error would be a far worse trade than losing one row of cost data.

export type SpendProvider = "dataforseo" | "anthropic" | "openai" | "pagespeed";

export type SpendEntry = {
  provider: SpendProvider;
  /** Endpoint path or model id, verbatim, so a spike traces back to a caller. */
  operation: string;
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  workspaceId?: string | null;
  articleId?: string | null;
  /** Groups the calls belonging to one generate, so a run can be totalled. */
  runId?: string | null;
};

export async function recordSpend(
  supabase: SupabaseClient,
  entry: SpendEntry,
): Promise<void> {
  try {
    await supabase.from("provider_spend").insert({
      workspace_id: entry.workspaceId ?? null,
      article_id: entry.articleId ?? null,
      provider: entry.provider,
      operation: entry.operation,
      // Not `?? 0`: a provider that reports no cost is a different fact from a
      // call that was free, and averaging the two would understate the bill.
      cost_usd: entry.costUsd ?? null,
      input_tokens: entry.inputTokens ?? null,
      output_tokens: entry.outputTokens ?? null,
      run_id: entry.runId ?? null,
    });
  } catch {
    // Bookkeeping never breaks the work it is measuring.
  }
}

/**
 * Anthropic bills per token and reports no price, so the price list lives here.
 *
 * USD per million tokens, from Anthropic's published pricing. Kept in one place
 * and dated, because a stale rate produces a confident wrong margin, which is
 * worse than no margin at all.
 *
 * Last checked 2026-08-30.
 */
export const ANTHROPIC_RATES: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "claude-opus-5": { input: 15, output: 75 },
};

/** Cost of a call in USD, or null when the model's rate is not known here. */
export function anthropicCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const rate = ANTHROPIC_RATES[model];
  if (!rate) return null;
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}
