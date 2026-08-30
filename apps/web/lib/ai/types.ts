// ---------------------------------------------------------------------------
// AI content-generation types
// ---------------------------------------------------------------------------

import type { ArticleResearch } from "@/lib/seo/research";

export interface VoiceRules {
  tone?: string;
  vocabulary?: string[];
  avoidPatterns?: string[];
  tags?: string[];
  // Extended fields from AI analysis
  toneArchetype?: string;
  formalityLevel?: "casual" | "conversational" | "professional" | "formal" | "academic";
  sentenceRhythm?: string;
  emotionalRegister?: string;
  technicalDepth?: "beginner" | "intermediate" | "advanced" | "expert";
  audienceAwareness?: string;
  signaturePhrases?: string[];
  writingPatterns?: string[];
}

export interface ArticlePrompt {
  keyword: string;
  title?: string;
  voiceRules?: VoiceRules;
  targetWordCount?: number;
  language?: string;
  /**
   * SERP, intent, competitor and Search Console context for this keyword.
   *
   * Optional so that a self-hosted install with no DataForSEO credentials and
   * no connected Search Console still generates. When present the prompt
   * builder renders only the layers that actually loaded, so a partial bundle
   * degrades to a shorter prompt rather than to invented context.
   */
  research?: ArticleResearch;
}

export interface ArticleResult {
  html: string;
  title: string;
  metaDescription: string;
  wordCount: number;
  tokensUsed: number;
}

/**
 * Every AI backend (Claude, OpenAI, ...) must implement this interface.
 *
 * `streamArticle` is an async generator that:
 *   - yields incremental HTML chunks while the model streams
 *   - returns the final `ArticleResult` once the stream ends
 */
export interface AIProvider {
  streamArticle(prompt: ArticlePrompt): AsyncGenerator<string, ArticleResult>;
}
