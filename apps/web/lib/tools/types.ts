// ---------------------------------------------------------------------------
// Free tools — shared types
// ---------------------------------------------------------------------------

// ── Generic wrapper ─────────────────────────────────────────────────────────

export type ToolResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

// ── Content Brief Generator ─────────────────────────────────────────────────

export type BriefOutlineSection = {
  h2: string;
  h3s: string[];
  keyPoints: string[];
};

export type BriefFAQ = {
  question: string;
  answer: string;
};

export type SerpCompetitor = {
  title: string;
  url: string;
  description: string;
  wordCount: number | null;
};

export type LSIKeyword = {
  keyword: string;
  searchVolume: number | null;
  competition: number | null;
};

export type ContentBrief = {
  keyword: string;
  title: string;
  metaDescription: string;
  outline: BriefOutlineSection[];
  lsiKeywords: LSIKeyword[];
  faqs: BriefFAQ[];
  wordCountTarget: number;
  competitorInsights: string;
};

// ── Meta Description Generator ──────────────────────────────────────────────

export type MetaVariant = {
  text: string;
  charCount: number;
  style: string;
};

export type MetaDescriptionResult = {
  keyword: string;
  url?: string;
  variants: MetaVariant[];
};

// ── SEO Health Checker ──────────────────────────────────────────────────────

export type HealthIssue = {
  type: string;
  severity: "error" | "warning" | "info" | "pass";
  message: string;
  details?: string;
};

export type HealthCheckResult = {
  url: string;
  score: number;
  title: string;
  metaDescription: string;
  issues: HealthIssue[];
  pageSpeed: {
    performanceScore: number;
    lcp: number;
    cls: number;
    tbt: number;
  } | null;
  headings: { h1: string[]; h2: string[] };
  imageCount: number;
  imagesWithoutAlt: number;
  internalLinks: number;
  externalLinks: number;
  wordCount: number;
  loadTimeMs: number;
};

// ── SERP Analyzer ───────────────────────────────────────────────────────────

export type SerpAnalysisItem = {
  position: number;
  title: string;
  url: string;
  domain: string;
  description: string;
  wordCount: number | null;
};

export type SerpAnalysisResult = {
  keyword: string;
  locale: string;
  organic: SerpAnalysisItem[];
  peopleAlsoAsk: string[];
  avgWordCount: number | null;
  aiInsights: string;
};

// ── Keyword Gap Analyzer ────────────────────────────────────────────────────

export type GapKeyword = {
  keyword: string;
  volume: number;
  /** 0-100, or null when the keyword provider supplied none. */
  difficulty: number | null;
  cpc: number;
  intent: string;
  yourPosition: number | null;
  competitors: Record<string, number | null>;
};

export type KeywordGapResult = {
  yourDomain: string;
  competitorDomains: string[];
  gaps: GapKeyword[];
  totalGapsFound: number;
};

// ── Keyword Cluster Mapper ──────────────────────────────────────────────────

export type ClusterKeyword = {
  keyword: string;
  volume: number;
  difficulty: number;
};

export type KeywordCluster = {
  name: string;
  theme: string;
  keywords: ClusterKeyword[];
  totalVolume: number;
  avgDifficulty: number;
  suggestedPageType: string;
};

export type KeywordClusterResult = {
  seedKeywords: string[];
  clusters: KeywordCluster[];
  totalKeywords: number;
  totalVolume: number;
};
