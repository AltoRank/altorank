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

/** The row as `workspace_output_settings` stores it. */
export interface OutputSettingsRow {
  tone: string;
  internal_links: number;
  table_of_contents: boolean;
  call_to_action: boolean;
  first_person: boolean;
  mention_similar_products: boolean;
  global_article_prompt: string | null;
}

/**
 * Row to settings. Null row means the site has never saved any, so the
 * defaults apply - the same defaults the database would insert.
 */
export function outputFromRow(row: OutputSettingsRow | null | undefined): OutputSettings {
  if (!row) return DEFAULT_OUTPUT_SETTINGS;
  return {
    tone: (TONES as readonly string[]).includes(row.tone) ? (row.tone as Tone) : DEFAULT_OUTPUT_SETTINGS.tone,
    internalLinks: row.internal_links,
    tableOfContents: row.table_of_contents,
    callToAction: row.call_to_action,
    firstPerson: row.first_person,
    mentionSimilarProducts: row.mention_similar_products,
    globalArticlePrompt: row.global_article_prompt ?? "",
  };
}
