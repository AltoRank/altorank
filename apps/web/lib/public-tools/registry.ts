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
