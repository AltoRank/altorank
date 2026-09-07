// ---------------------------------------------------------------------------
// Errors a provider throws, in a module that imports no provider
// ---------------------------------------------------------------------------
//
// lib/content/generate.ts needs to recognise one of these in its catch, and
// it must not pull the Anthropic SDK in to do so: the agent mutation routes
// import generate.ts and their tests run under a five-second budget that the
// SDK's import alone was enough to break.

/**
 * The run stopped at `max_tokens`. Carries the usage the API reported, so the
 * caller can record what the call cost: a truncated draft is thrown away, but
 * the tokens were billed all the same, and until 2026-09-07 a failed run left
 * no provider_spend row at all - 24,000 output tokens invisible to the ledger.
 */
export class GenerationTruncatedError extends Error {
  constructor(
    public readonly inputTokens: number,
    public readonly outputTokens: number,
    public readonly chars: number,
  ) {
    super(
      `Generation hit the token ceiling after ${outputTokens} output tokens ` +
        `(${chars} chars of article). Raise max_tokens or lower the ` +
        `target word count; storing a truncated draft would be worse.`,
    );
    this.name = "GenerationTruncatedError";
  }
}

