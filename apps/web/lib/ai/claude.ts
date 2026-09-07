import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt, buildUserMessage } from "./prompts";
import type { AIProvider, ArticlePrompt, ArticleResult } from "./types";
import { extractArticleMeta, countWords } from "./utils";
import { anthropicModel } from "./models";

// ---------------------------------------------------------------------------
// Claude (Anthropic) provider
// ---------------------------------------------------------------------------

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
       * and this call streams, so the HTTP timeout is not a concern.
       */
      max_tokens: 64_000,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: buildUserMessage(prompt),
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
  }
}
