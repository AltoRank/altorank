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
   * Per-site output preferences from onboarding / settings. Every field is a
   * prompt switch; none of them touches what publishes.
   */
  output?: OutputPrefs;
  /**
   * What the site owner said about this keyword in particular: the shape the
   * article should take, how long it should run, standing instructions, and
   * their answers to the first-hand-experience questions. Rendered as its own
   * section, quoted rather than paraphrased, and never extended: the model may
   * use exactly what is here as the owner's experience and nothing more.
   */
  brief?: ArticleBrief;
  /**
   * Rewrite an existing page rather than write a new one.
   *
   * The prompt gets the current body and a brief, and is told to preserve
   * structure, links and images while strengthening what the brief names.
   * Everything downstream (typography, link checks, scoring) is the same
   * pipeline a fresh draft goes through.
   */
  refreshOf?: RefreshContext;
  /**
   * Who the article is for: the business profile the wizard inferred from
   * the site and the owner confirmed. Without it the writer knew the keyword,
   * the SERP and the house style, and nothing about the business - so the
   * closing rule "no paragraph that would still be true if the subject were a
   * different product" had no subject to hold it to.
   */
  site?: SiteContext;
  /**
   * What the business's own pages say: its services and the pages that name
   * them, the work its portfolio shows, what its about page states, and the
   * checked page a ready reader should go to. Read off pages the crawl
   * already fetched (lib/content/site-facts.ts). A real signup's first
   * article (2026-09-22) marketed the category rather than him because none
   * of this reached the writer.
   */
  siteFacts?: SiteFacts;
}

/** `workspaces.business_profile`, the fields a writer can use. */
export interface SiteContext {
  name?: string | null;
  description?: string | null;
  audiences?: string[];
  /** What people buy from it, as the profile states it. */
  offerings?: string[];
  /**
   * A person saved this profile (`business_profile.confirmedAt`). False when
   * it was read off the site by a model and saved unattended; the prompt
   * says which, rather than calling a model's reading the owner's words.
   */
  confirmed?: boolean;
}

/**
 * The business as its own site describes it, for the writer. Every entry
 * came off a page that answered 2xx; every URL here is one the article may
 * link to. `notes` are the things the writer must be told plainly: what was
 * not found, and what could not be checked.
 */
export interface SiteFacts {
  /** Pages of this site that were fetched and answered 2xx. */
  pagesRead: number;
  /** Services or products, by the names its pages use. `url` only when that page was itself fetched. */
  offerings: Array<{ name: string; url: string | null }>;
  /** Projects, case studies and clients its portfolio shows, by the names it uses. */
  work: Array<{ name: string; url: string | null }>;
  /**
   * The headings on its services, portfolio and pricing pages, as they are.
   * Kept apart from `offerings` and `work` because a heading can as easily
   * be "Why us?" as a service; the writer reads them as the page's outline.
   */
  headings: Array<{ page: string; url: string; items: string[] }>;
  /** Founding, team and location statements, as the page makes them, with the page. */
  /** `from: "structured-data"`: a value from the page's JSON-LD, not the site's words (lib/audit/site-extract.ts). */
  stated: Array<{ kind: "founded" | "team" | "location"; text: string; source: string; from?: "structured-data" }>;
  /** The opening of its about page, in its own words. */
  about: { text: string; source: string } | null;
  /** Its section pages (services, portfolio, about, contact, pricing), which exist. */
  pages: Array<{ role: string; name: string; url: string }>;
  /** Where a ready reader should go, and how that was checked. Null when nothing could be. */
  conversion: { url: string; check: string } | null;
  notes: string[];
}

export interface ArticleBrief {
  instructions?: string | null;
  /** Only answered questions belong here; an unanswered one is not a fact. */
  answers: Array<{ question: string; answer: string }>;
  articleType?: string | null;
  articleSubtype?: string | null;
  /** One of the length bands, or "auto" to defer to the research. */
  expectedLength?: string | null;
}

export interface OutputPrefs {
  tone?: string;
  internalLinks?: number;
  tableOfContents?: boolean;
  callToAction?: boolean;
  firstPerson?: boolean;
  mentionSimilarProducts?: boolean;
  /** Emojis in headings and lists. False is an explicit ban, not silence. */
  emojis?: boolean;
  /** Free-text rules the site owner wrote; they outrank everything but safety. */
  customInstructions?: string | null;
  /**
   * `workspace_output_settings.faq_schema`. The enrichment reads FAQPage
   * data out of a FAQ section the article already has; this asks the writer
   * for one, which nothing did before, so the switch was on for a section
   * that appeared only when the model felt like it.
   */
  faq?: boolean;
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
