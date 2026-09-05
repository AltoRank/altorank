import OpenAI from "openai";
import { buildSystemPrompt, buildUserMessage } from "./prompts";
import type { AIProvider, ArticlePrompt, ArticleResult } from "./types";
import { extractArticleMeta, countWords } from "./utils";
import { openaiModel } from "./models";

// ---------------------------------------------------------------------------
// OpenAI provider
// ---------------------------------------------------------------------------

export class OpenAIProvider implements AIProvider {
  private client: OpenAI;
  private model: string;

  constructor(model?: string) {
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    // A workspace-level `ai_model` still wins; this is only the fallback.
    this.model = model || openaiModel();
  }

  async *streamArticle(
    prompt: ArticlePrompt
  ): AsyncGenerator<string, ArticleResult> {
    const systemPrompt = buildSystemPrompt(prompt);

    const stream = await this.client.chat.completions.create({
      model: this.model,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 8192,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: buildUserMessage(prompt),
        },
      ],
    });

    let fullHtml = "";
    let totalTokens = 0;

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        fullHtml += delta;
        yield delta;
      }

      // The final chunk with usage stats has an empty choices array
      if (chunk.usage) {
        totalTokens = chunk.usage.total_tokens;
      }
    }

    const { title, metaDescription, cleanHtml } = extractArticleMeta(fullHtml);

    return {
      html: cleanHtml,
      title,
      metaDescription,
      wordCount: countWords(cleanHtml),
      tokensUsed: totalTokens,
    };
  }
}
