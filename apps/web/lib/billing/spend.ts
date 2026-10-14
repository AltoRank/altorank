import type { SupabaseClient } from "@supabase/supabase-js";
import { currentSpendScope, scopeAttribution, type SpendStage } from "./spend-scope";

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
  /** Which stage of a first look bought it. Taken from the spend scope when not given. */
  stage?: SpendStage | null;
};

export async function recordSpend(
  supabase: SupabaseClient,
  entry: SpendEntry,
): Promise<void> {
  try {
    // What the entry does not say, the scope it was made in does
    // (lib/billing/spend-scope.ts): the workspace, the article, and - for a
    // first look, whose run id wins over a generation job's - the run and
    // the stage.
    const scope = scopeAttribution(currentSpendScope());
    const row: Record<string, unknown> = {
      workspace_id: entry.workspaceId ?? scope.workspaceId,
      article_id: entry.articleId ?? scope.articleId,
      provider: entry.provider,
      operation: entry.operation,
      // Not `?? 0`: a provider that reports no cost is a different fact from a
      // call that was free, and averaging the two would understate the bill.
      cost_usd: entry.costUsd ?? null,
      input_tokens: entry.inputTokens ?? null,
      output_tokens: entry.outputTokens ?? null,
      run_id: currentSpendScope()?.budget?.runId ?? entry.runId ?? scope.runId,
    };
    const stage = entry.stage ?? scope.stage;
    if (stage) row.stage = stage;
    const { error } = (await supabase.from("provider_spend").insert(row)) ?? {};
    // A database without migration 106 has no `stage`: the row is worth more
    // than its tag, so it goes in without one.
    if (error && stage && /stage/.test(error.message ?? "")) {
      delete row.stage;
      await supabase.from("provider_spend").insert(row);
    }
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
 * Last checked 2026-09-30, against Anthropic's model table: Sonnet 5 is $2/$10
 * and Opus 5 $5/$25. Until then Sonnet 5 was billed here at $3/$15 (the
 * Sonnet 4.6 rate) and Opus 5 at $15/$75, so every Sonnet spend row read 1.5x
 * what was paid.
 */
export const ANTHROPIC_RATES: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "claude-opus-5": { input: 5, output: 25 },
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

/** The dearest rate in the table: what an estimate assumes for a model it does not know. */
const DEAREST = Object.values(ANTHROPIC_RATES).reduce((a, b) => (b.output > a.output ? b : a));

/**
 * What an Anthropic call can cost at most, before it is made: the prompt at
 * 2.5 characters a token (fewer than any language the product writes in
 * uses, so the input side is over-counted) and every output token the call
 * allows. The first look's budget claims this and settles the real price
 * (lib/billing/spend-scope.ts).
 */
export function anthropicEstimate(model: string, promptChars: number, maxTokens: number): number {
  const rate = ANTHROPIC_RATES[model] ?? DEAREST;
  const inputTokens = Math.ceil(Math.max(0, promptChars) / 2.5) + 64;
  return (inputTokens * rate.input + Math.max(0, maxTokens) * rate.output) / 1_000_000;
}

/** USD per output token for `model`, at the dearest known rate when it is not listed. */
export function anthropicOutputRate(model: string): number {
  return (ANTHROPIC_RATES[model] ?? DEAREST).output / 1_000_000;
}
