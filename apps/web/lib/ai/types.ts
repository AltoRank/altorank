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
  /**
   * Other articles in this workspace, so an internal link can point at
   * something that exists.
   *
   * The prompt has always asked for `{{internal-link:topic}}` placeholders, but
   * never said what there was to link to, so "where relevant" read as "probably
   * not": zero placeholders across six generated articles. A model cannot link
   * to a library it has not been shown.
   */
  internalLinkTargets?: Array<{ title: string; keyword: string }>;
  /**
   * Rewrite an existing page rather than write a new one.
   *
   * The prompt gets the current body and a brief, and is told to preserve
   * structure, links and images while strengthening what the brief names.
   * Everything downstream (typography, link checks, scoring) is the same
   * pipeline a fresh draft goes through.
   */
  refreshOf?: RefreshContext;
}

export interface RefreshContext {
  /** The page's current body, as HTML. */
  existingHtml: string;
  /** What to strengthen, which questions to add, what to keep. Human-editable. */
  brief: string;
  /** Where the page lives, for the model's orientation only. */
  url?: string | null;
  title?: string | null;
  metaDescription?: string | null;
}

export interface ArticleResult {
  html: string;
  title: string;
  metaDescription: string;
  wordCount: number;
  tokensUsed: number;
  /** Split out because input and output bill at different rates. */
  inputTokens?: number;
  outputTokens?: number;
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
