// ---------------------------------------------------------------------------
// Every public tool, by slug
// ---------------------------------------------------------------------------
//
// POST /api/public/tools/<slug> looks the slug up here and nowhere else; a
// slug not in this list is a 404. To add a tool, write it under ./tools/ and
// add one line below (see ./README.md).

import type { PublicTool } from "./types";
import { aiCrawlerSimulator } from "./tools/ai-crawler-simulator";
import { websiteMetadataChecker } from "./tools/website-metadata-checker";
import { robotsTxtTester } from "./tools/robots-txt-tester";
import { canonicalChecker } from "./tools/canonical-checker";
import { sitemapChecker } from "./tools/sitemap-checker";
import { linkExtractor } from "./tools/link-extractor";
import { seoTitleGenerator } from "./tools/seo-title-generator";
import { headlineGenerator } from "./tools/headline-generator";
import { blogOutlineGenerator } from "./tools/blog-outline-generator";
import { ctaGenerator } from "./tools/cta-generator";
import { adCopyGenerator } from "./tools/ad-copy-generator";
import { articleRewriter } from "./tools/article-rewriter";
import { articleSummarizer } from "./tools/article-summarizer";
import { grammarChecker } from "./tools/grammar-checker";
import { contentIdeaGenerator } from "./tools/content-idea-generator";
import { emailSubjectLineGenerator } from "./tools/email-subject-line-generator";
import { socialMediaPostGenerator } from "./tools/social-media-post-generator";
import { aiArticleGenerator } from "./tools/ai-article-generator";
import { altTextGenerator } from "./tools/alt-text-generator";
import { lsiKeywordGenerator } from "./tools/lsi-keyword-generator";
import { keywordResearch } from "./tools/keyword-research";
import { blogPostIdeas } from "./tools/blog-post-ideas";
import { googleRankChecker } from "./tools/google-rank-checker";
import { backlinkChecker } from "./tools/backlink-checker";
import { websiteWorthCalculator } from "./tools/website-worth-calculator";
import { plagiarismChecker } from "./tools/plagiarism-checker";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each tool has its own input type; the handler validates before calling run()
export type AnyPublicTool = PublicTool<any>;

const TOOLS: AnyPublicTool[] = [
  // fetch tools (free)
  aiCrawlerSimulator,
  websiteMetadataChecker,
  robotsTxtTester,
  canonicalChecker,
  sitemapChecker,
  linkExtractor,
  // ai tools (paid, spend-guarded)
  seoTitleGenerator,
  headlineGenerator,
  blogOutlineGenerator,
  ctaGenerator,
  adCopyGenerator,
  articleRewriter,
  articleSummarizer,
  grammarChecker,
  contentIdeaGenerator,
  emailSubjectLineGenerator,
  socialMediaPostGenerator,
  aiArticleGenerator,
  altTextGenerator,
  lsiKeywordGenerator,
  // data tools (paid, spend-guarded)
  keywordResearch,
  blogPostIdeas,
  googleRankChecker,
  backlinkChecker,
  websiteWorthCalculator,
  plagiarismChecker,
];

const BY_SLUG = new Map<string, AnyPublicTool>();
for (const tool of TOOLS) {
  if (BY_SLUG.has(tool.slug)) throw new Error(`Duplicate public tool slug: ${tool.slug}`);
  if (tool.kind === "fetch" && tool.estimateCents !== 0) {
    throw new Error(`Fetch tool ${tool.slug} must have estimateCents 0`);
  }
  BY_SLUG.set(tool.slug, tool);
}

export function getTool(slug: string): AnyPublicTool | undefined {
  return BY_SLUG.get(slug);
}

export function listTools(): AnyPublicTool[] {
  return [...BY_SLUG.values()];
}
