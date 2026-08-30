// ---------------------------------------------------------------------------
// Tool registry — single source of truth for all free tool metadata
// ---------------------------------------------------------------------------

export type ToolEntry = {
  slug: string;
  name: string;
  description: string;
  category: "content" | "keyword" | "technical" | "analytics";
  rateLimit: number;
  rateWindowMs: number;
  available: boolean;
};

const ONE_HOUR = 60 * 60 * 1000;

export const TOOL_REGISTRY: ToolEntry[] = [
  {
    slug: "content-brief-generator",
    name: "Content Brief Generator",
    description:
      "Get a full content brief from a keyword — outline, LSI keywords, FAQs, meta suggestions, and word count target.",
    category: "content",
    rateLimit: 3,
    rateWindowMs: ONE_HOUR,
    available: true,
  },
  {
    slug: "meta-description-generator",
    name: "Meta Description Generator",
    description:
      "Generate compelling, keyword-rich meta descriptions optimized for click-through rate.",
    category: "content",
    rateLimit: 5,
    rateWindowMs: ONE_HOUR,
    available: true,
  },
  {
    slug: "seo-health-checker",
    name: "SEO Health Checker",
    description:
      "Audit any page for SEO issues — meta tags, headings, images, speed, and more.",
    category: "technical",
    rateLimit: 3,
    rateWindowMs: ONE_HOUR,
    available: true,
  },
  {
    slug: "serp-analyzer",
    name: "SERP Analyzer",
    description:
      "Analyze top Google results for any keyword — word counts, headings, domains, and content gaps.",
    category: "analytics",
    rateLimit: 3,
    rateWindowMs: ONE_HOUR,
    available: true,
  },
  {
    slug: "keyword-gap-analyzer",
    name: "Keyword Gap Analyzer",
    description:
      "Find keywords your competitors rank for that you don't. Discover untapped ranking opportunities.",
    category: "keyword",
    rateLimit: 2,
    rateWindowMs: ONE_HOUR,
    available: true,
  },
  {
    slug: "keyword-cluster-mapper",
    name: "Keyword Cluster Mapper",
    description:
      "Group related keywords into topical clusters for your content strategy.",
    category: "keyword",
    rateLimit: 3,
    rateWindowMs: ONE_HOUR,
    available: true,
  },
];

export function getToolBySlug(slug: string): ToolEntry | undefined {
  return TOOL_REGISTRY.find((t) => t.slug === slug);
}
