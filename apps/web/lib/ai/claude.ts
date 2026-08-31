import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt } from "./prompts";
import type { AIProvider, ArticlePrompt, ArticleResult } from "./types";
import { extractArticleMeta, countWords } from "./utils";
import { anthropicModel } from "./models";

// ---------------------------------------------------------------------------
// Claude (Anthropic) provider
// ---------------------------------------------------------------------------

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
       * A 3,000-word article is roughly 4,000-5,000 output tokens before
       * markup, so the ceiling has to clear thinking AND the piece.
       */
      max_tokens: 24_000,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `Write the article now for the keyword: "${prompt.keyword}"`,
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
      throw new Error(
        `Generation hit the token ceiling after ${outputTokens} output tokens ` +
          `(${fullHtml.length} chars of article). Raise max_tokens or lower the ` +
          `target word count; storing a truncated draft would be worse.`,
      );
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
