// The article-output preferences a site sets once. Shared by the wizard, the
// server actions, the settings page, the prompt and the enrichment pipeline;
// kept out of the "use server" module because such a module may export
// nothing but async functions.
//
// One parser (`outputFromRow`) turns the `workspace_output_settings` row into
// these, and everything that reads the table goes through it: an unknown
// value or a column an install does not have yet becomes the default, never
// a value invented on the way.

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

/**
 * Presets for images generated inside the body. The identifiers are the ones
 * `lib/content/enrich/labels.ts` writes into alt text and
 * `lib/ai/image-generator.ts` turns into prompt wording; the database check
 * lists the same five.
 */
export const IMAGE_STYLES = ["sketch", "watercolor", "realistic", "illustration", "brand-text"] as const;
export type ImageStyle = (typeof IMAGE_STYLES)[number];

/** Label and the one line that says what the prompt asks for. No sample images: we have none. */
export const IMAGE_STYLE_LABELS: Record<ImageStyle, { label: string; hint: string }> = {
  sketch: { label: "Sketch", hint: "Pencil line art, monochrome, white background." },
  watercolor: { label: "Watercolour", hint: "Soft washes with brush texture and paper grain." },
  realistic: { label: "Realistic", hint: "Photo-style editorial shot, natural light." },
  illustration: { label: "Illustration", hint: "Flat vector shapes, limited palette." },
  "brand-text": { label: "Brand and text", hint: "Abstract letterforms in your brand colour; no legible words." },
};

/**
 * The cover image. `title_cover` is the one image allowed to carry text;
 * `match_body` follows `imageStyle`; the rest are body presets used as a hero.
 */
export const FEATURED_IMAGE_STYLES = ["title_cover", "sketch", "watercolor", "illustration", "match_body"] as const;
export type FeaturedImageStyle = (typeof FEATURED_IMAGE_STYLES)[number];

export const FEATURED_IMAGE_STYLE_LABELS: Record<FeaturedImageStyle, { label: string; hint: string }> = {
  title_cover: {
    label: "Title cover",
    hint: "The article title set in large type on a plain background in your brand colour. Image models misspell sometimes; check it in review.",
  },
  sketch: { label: "Sketch", hint: IMAGE_STYLE_LABELS.sketch.hint },
  watercolor: { label: "Watercolour", hint: IMAGE_STYLE_LABELS.watercolor.hint },
  illustration: { label: "Illustration", hint: IMAGE_STYLE_LABELS.illustration.hint },
  match_body: { label: "Match body images", hint: "Whatever the body preset is, the cover uses it too." },
};

export interface OutputSettings {
  tone: Tone;
  internalLinks: number;
  tableOfContents: boolean;
  callToAction: boolean;
  firstPerson: boolean;
  mentionSimilarProducts: boolean;
  globalArticlePrompt: string;
  /** Chart the numbers the text already states. */
  infographics: boolean;
  /** One YouTube embed in the first how-to section. */
  video: boolean;
  /** Prompt switch; off means the model is told to use none. */
  emojis: boolean;
  /** FAQPage JSON-LD for a FAQ the article already has. */
  faqSchema: boolean;
  imageStyle: ImageStyle;
  featuredImageStyle: FeaturedImageStyle;
  /** `#rrggbb`, lower case, or null for none. */
  brandColor: string | null;
  /** `UC…` channel id or `@handle`, or null for any channel. */
  youtubeChannel: string | null;
}

export const DEFAULT_OUTPUT_SETTINGS: OutputSettings = {
  tone: "informative",
  internalLinks: 3,
  tableOfContents: true,
  callToAction: true,
  firstPerson: false,
  mentionSimilarProducts: false,
  globalArticlePrompt: "",
  infographics: true,
  video: true,
  emojis: false,
  faqSchema: true,
  imageStyle: "sketch",
  featuredImageStyle: "title_cover",
  brandColor: null,
  youtubeChannel: null,
};

export interface SiteDetails {
  sitemapUrl: string;
  blogRootUrl: string;
  exampleArticleUrls: string[];
}

/**
 * The row as `workspace_output_settings` stores it. Everything optional: a
 * `select("*")` on an install that has run 049 but not 064 returns the row
 * without the newer columns, and the parser fills the defaults.
 */
export interface OutputSettingsRow {
  tone?: string | null;
  internal_links?: number | null;
  table_of_contents?: boolean | null;
  call_to_action?: boolean | null;
  first_person?: boolean | null;
  mention_similar_products?: boolean | null;
  global_article_prompt?: string | null;
  infographics?: boolean | null;
  video?: boolean | null;
  emojis?: boolean | null;
  faq_schema?: boolean | null;
  image_style?: string | null;
  featured_image_style?: string | null;
  brand_color?: string | null;
  youtube_channel?: string | null;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const HANDLE = /^@[A-Za-z0-9_.-]{3,30}$/;

/** `#RRGGBB` in any case to lower-case `#rrggbb`; anything else is null. */
export function parseBrandColor(input: string | null | undefined): string | null {
  const v = (input ?? "").trim();
  return HEX_COLOR.test(v) ? v.toLowerCase() : null;
}

/**
 * A YouTube channel as a person would paste it: `UC…` id, `@handle`, or the
 * channel URL in either form. Stored as the id or the handle; anything else
 * is null, and the form says so rather than saving a string the search API
 * would ignore.
 */
export function parseYouTubeChannel(input: string | null | undefined): string | null {
  let v = (input ?? "").trim();
  if (!v) return null;
  const url = v.match(/^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/(?:channel\/)?(@?[^/?#]+)/i);
  if (url) v = url[1];
  if (CHANNEL_ID.test(v)) return v;
  if (HANDLE.test(v)) return v;
  return null;
}

function pick<T extends string>(list: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && (list as readonly string[]).includes(value) ? (value as T) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Row to settings. Null row means the site has never saved any, so the
 * defaults apply - the same defaults the database would insert.
 */
export function outputFromRow(row: OutputSettingsRow | null | undefined): OutputSettings {
  if (!row) return DEFAULT_OUTPUT_SETTINGS;
  const d = DEFAULT_OUTPUT_SETTINGS;
  return {
    tone: pick(TONES, row.tone, d.tone),
    internalLinks: typeof row.internal_links === "number" ? row.internal_links : d.internalLinks,
    tableOfContents: bool(row.table_of_contents, d.tableOfContents),
    callToAction: bool(row.call_to_action, d.callToAction),
    firstPerson: bool(row.first_person, d.firstPerson),
    mentionSimilarProducts: bool(row.mention_similar_products, d.mentionSimilarProducts),
    globalArticlePrompt: row.global_article_prompt ?? "",
    infographics: bool(row.infographics, d.infographics),
    video: bool(row.video, d.video),
    emojis: bool(row.emojis, d.emojis),
    faqSchema: bool(row.faq_schema, d.faqSchema),
    imageStyle: pick(IMAGE_STYLES, row.image_style, d.imageStyle),
    featuredImageStyle: pick(FEATURED_IMAGE_STYLES, row.featured_image_style, d.featuredImageStyle),
    brandColor: parseBrandColor(row.brand_color),
    youtubeChannel: parseYouTubeChannel(row.youtube_channel),
  };
}

/**
 * Settings to the row the upsert writes. The same normalisation the parser
 * applies, so what is saved is exactly what will be read back.
 */
export function outputToRow(s: OutputSettings): Required<OutputSettingsRow> {
  return {
    tone: pick(TONES, s.tone, DEFAULT_OUTPUT_SETTINGS.tone),
    internal_links: Math.max(0, Math.min(10, Math.round(Number(s.internalLinks) || 3))),
    table_of_contents: Boolean(s.tableOfContents),
    call_to_action: Boolean(s.callToAction),
    first_person: Boolean(s.firstPerson),
    mention_similar_products: Boolean(s.mentionSimilarProducts),
    global_article_prompt: s.globalArticlePrompt.trim() || null,
    infographics: Boolean(s.infographics),
    video: Boolean(s.video),
    emojis: Boolean(s.emojis),
    faq_schema: Boolean(s.faqSchema),
    image_style: pick(IMAGE_STYLES, s.imageStyle, DEFAULT_OUTPUT_SETTINGS.imageStyle),
    featured_image_style: pick(FEATURED_IMAGE_STYLES, s.featuredImageStyle, DEFAULT_OUTPUT_SETTINGS.featuredImageStyle),
    brand_color: parseBrandColor(s.brandColor),
    youtube_channel: parseYouTubeChannel(s.youtubeChannel),
  };
}

/**
 * What the cover image is generated in. `title_cover` has no body preset: it
 * is type on a plain ground, so `style` is null and `titleCover` is on.
 */
export function resolveFeaturedImage(s: Pick<OutputSettings, "imageStyle" | "featuredImageStyle">): {
  style: ImageStyle | null;
  titleCover: boolean;
} {
  switch (s.featuredImageStyle) {
    case "title_cover":
      return { style: null, titleCover: true };
    case "match_body":
      return { style: s.imageStyle, titleCover: false };
    default:
      return { style: s.featuredImageStyle, titleCover: false };
  }
}
