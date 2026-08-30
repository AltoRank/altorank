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
      max_tokens: 8192,
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

    const { title, metaDescription, cleanHtml } = extractArticleMeta(fullHtml);

    return {
      html: cleanHtml,
      title,
      metaDescription,
      wordCount: countWords(cleanHtml),
      tokensUsed: inputTokens + outputTokens,
    };
  }
}
