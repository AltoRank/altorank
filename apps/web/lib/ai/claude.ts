import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt, buildUserMessage } from "./prompts";
import type { AIProvider, ArticlePrompt, ArticleResult } from "./types";
import { extractArticleMeta, countWords } from "./utils";
import { anthropicModel } from "./models";
import { GenerationTruncatedError } from "./errors";
import { anthropicCost, anthropicEstimate, anthropicOutputRate } from "@/lib/billing/spend";
import { claimSpend } from "@/lib/billing/spend-scope";

export { GenerationTruncatedError };

// ---------------------------------------------------------------------------
// Claude (Anthropic) provider
// ---------------------------------------------------------------------------

/**
 * The writer's output ceiling: headroom for thinking plus the article (see
 * the note on `max_tokens` below for how 8,192 and 24,000 each failed).
 */
export const WRITER_MAX_TOKENS = 64_000;
/**
 * The least a budgeted writer is sent with. Below this a draft is likelier to
 * be cut off mid-article than finished - one Sonnet 5 run thought for ~19,000
 * tokens before writing - so the claim is refused instead and the first look
 * keeps its money (lib/billing/spend-scope.ts).
 */
export const WRITER_MIN_OUTPUT_TOKENS = 16_000;

export class ClaudeProvider implements AIProvider {
  private client: Anthropic;
  private model: string;

  constructor(model?: string) {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    // A workspace-level `ai_model` still wins; this is only the fallback.
    this.model = model || anthropicModel("content");
  }

  async *streamArticle(
    prompt: ArticlePrompt
  ): AsyncGenerator<string, ArticleResult> {
    const systemPrompt = buildSystemPrompt(prompt);
    const userMessage = buildUserMessage(prompt);

    // Under a first look's budget (lib/billing/spend-scope.ts) the writer
    // claims what the budget has, up to the full ceiling below and never
    // less than WRITER_MIN_OUTPUT_TOKENS of room, and is cut off at what it
    // was granted: that is what makes the dollar hard. Anywhere else the
    // claim is granted whole and nothing changes. A refusal throws
    // BudgetRefusedError before anything is sent.
    const inputUsd = anthropicEstimate(this.model, systemPrompt.length + userMessage.length, 0);
    const perToken = anthropicOutputRate(this.model);
    const wantUsd = inputUsd + WRITER_MAX_TOKENS * perToken;
    const claim = await claimSpend(this.model, wantUsd, {
      minUsd: inputUsd + WRITER_MIN_OUTPUT_TOKENS * perToken,
    });
    const maxTokens = claim.grantedUsd >= wantUsd
      ? WRITER_MAX_TOKENS
      : Math.min(WRITER_MAX_TOKENS, Math.floor((claim.grantedUsd - inputUsd) / perToken));
    // Null until the price is known: a stream that failed part-way may have
    // been billed for what it generated, so its grant stays committed.
    let charged: number | null = null;
    try {
      const stream = this.client.messages.stream({
        model: this.model,
        /**
         * Headroom for thinking plus the article.
         *
         * 8192 was not enough and failed silently. Sonnet 5 spent 6,210 tokens
         * thinking on a 3,000-word brief, leaving under 2,000 for prose, hit
         * max_tokens mid-article, and on one run produced no text block at all -
         * so a generation that burned 12,529 tokens stored an empty document
         * titled "Untitled". Measured on 2026-08-30.
         *
         * 24,000 was not enough either. With no `thinking` parameter Sonnet 5
         * runs adaptive thinking at the default effort, and how much it thinks
         * is the model's call: on 2026-09-07 one run spent ~19,000 tokens
         * thinking about a 2,400-3,200-word comparison guide and was cut off at
         * 12,638 characters of article - a $0.25 call with nothing to show.
         * The ceiling is an enforced cutoff the model does not see, so it has
         * to sit well above the worst thinking run plus the longest article:
         * 64,000 (the SDK's own streaming default) costs nothing when unused,
         * and this call streams, so the HTTP timeout is not a concern. Under a
         * first look's budget it is lowered to what the budget granted.
         */
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: userMessage,
          },
        ],
      });

      let fullHtml = "";
      let inputTokens = 0;
      let outputTokens = 0;

      for await (const event of stream) {
        // Accumulate text deltas
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          const chunk = event.delta.text;
          fullHtml += chunk;
          yield chunk;
        }

        // Capture token usage from the final message event
        if (event.type === "message_delta" && event.usage) {
          outputTokens = event.usage.output_tokens;
        }
      }

      // Get final message for input token count
      const finalMessage = await stream.finalMessage();
      inputTokens = finalMessage.usage?.input_tokens ?? 0;
      if (!outputTokens) {
        outputTokens = finalMessage.usage?.output_tokens ?? 0;
      }
      charged = anthropicCost(this.model, inputTokens, outputTokens);

      // Truncation has to be loud. A run that stops at the ceiling produces a
      // half-article or, when thinking consumed the whole budget, none at all -
      // and both used to be stored as a finished draft.
      if (finalMessage.stop_reason === "max_tokens") {
        throw new GenerationTruncatedError(inputTokens, outputTokens, fullHtml.length);
      }

      const { title, metaDescription, cleanHtml } = extractArticleMeta(fullHtml);

      return {
        html: cleanHtml,
        title,
        metaDescription,
        wordCount: countWords(cleanHtml),
        tokensUsed: inputTokens + outputTokens,
        inputTokens,
        outputTokens,
      };
    } finally {
      await claim.settle(charged);
    }
  }
}
