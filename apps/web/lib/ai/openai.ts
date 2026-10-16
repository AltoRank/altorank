import OpenAI from "openai";
import { buildSystemPrompt, buildUserMessage } from "./prompts";
import type { AIProvider, ArticlePrompt, ArticleResult, StreamOptions } from "./types";
import { extractArticleMeta, countWords } from "./utils";
import { openaiModel } from "./models";
import { GenerationTimedOutError } from "./errors";
import { until } from "@/lib/onboarding/deadline";

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
    prompt: ArticlePrompt,
    options: StreamOptions = {},
  ): AsyncGenerator<string, ArticleResult> {
    const { signal } = options;
    const startedAt = Date.now();
    if (signal?.aborted) throw new GenerationTimedOutError(0, 0);
    const systemPrompt = buildSystemPrompt(prompt);

    let fullHtml = "";
    let totalTokens = 0;
    // Bounded by `signal` end to end, as the Claude writer is (./claude.ts):
    // the SDK's timeout does not cover reading the stream.
    try {
      const request = this.client.chat.completions.create({
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
      }, signal ? { signal } : undefined);
      const stream = signal ? await until(request, signal, "writer") : await request;

      const chunks = stream[Symbol.asyncIterator]();
      while (true) {
        const next = signal ? await until(chunks.next(), signal, "writer") : await chunks.next();
        if (next.done) break;
        const chunk = next.value;
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
    } catch (err) {
      if (signal?.aborted) throw new GenerationTimedOutError(Date.now() - startedAt, fullHtml.length);
      throw err;
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
