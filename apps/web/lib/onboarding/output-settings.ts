// The article-output preferences a site sets once. Shared by the wizard, the
// server actions and the page; kept out of the "use server" module because
// such a module may export nothing but async functions.

export const TONES = [
  "informative", "simple", "formal", "casual", "enthusiastic", "persuasive",
  "professional", "friendly", "entertaining", "inspirational", "analytical", "narrative",
] as const;
export type Tone = (typeof TONES)[number];

export const TONE_LABELS: Record<Tone, string> = {
  informative: "Informative",
  simple: "Simple and clear",
  formal: "Formal",
  casual: "Casual",
  enthusiastic: "Enthusiastic",
  persuasive: "Persuasive",
  professional: "Professional",
  friendly: "Friendly",
  entertaining: "Entertaining",
  inspirational: "Inspirational",
  analytical: "Analytical",
  narrative: "Narrative",
};

export interface OutputSettings {
  tone: Tone;
  internalLinks: number;
  tableOfContents: boolean;
  callToAction: boolean;
  firstPerson: boolean;
  mentionSimilarProducts: boolean;
  globalArticlePrompt: string;
}

export const DEFAULT_OUTPUT_SETTINGS: OutputSettings = {
  tone: "informative",
  internalLinks: 3,
  tableOfContents: true,
  callToAction: true,
  firstPerson: false,
  mentionSimilarProducts: false,
  globalArticlePrompt: "",
};

export interface SiteDetails {
  sitemapUrl: string;
  blogRootUrl: string;
  exampleArticleUrls: string[];
}
