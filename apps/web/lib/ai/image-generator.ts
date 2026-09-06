import OpenAI from "openai";
import { openaiImageModel } from "./models";
import type { ImageStyle } from "@/lib/onboarding/output-settings";

// ---------------------------------------------------------------------------
// Featured images
// ---------------------------------------------------------------------------
//
// The gpt-image models, not DALL-E 3. Checked against the live account on
// 2026-09-04: `dall-e-3` is not in its model list at all, so the previous
// default could only ever have returned a model-not-found error - which the
// caller then swallowed, which is why every article in the database has no
// image and nothing said why.
//
// Three things differ from the DALL-E call this replaces, and all three would
// have failed independently:
//
//   size      1792x1024 is a DALL-E size. These models take 1024x1024,
//             1536x1024 or 1024x1536.
//   quality   "standard" is a DALL-E value. These take low, medium or high.
//   response  DALL-E returned a hosted URL with an expiry. These return base64
//             and nothing else, so there is no URL to download from and the
//             bytes go straight to storage.

export interface ImageGenerationResult {
  /** The image itself. These models return bytes, never a URL to fetch. */
  data: Buffer;
  contentType: string;
  /** File extension matching `contentType`, for the storage path. */
  extension: string;
  revisedPrompt?: string;
}

/**
 * Landscape, because this is a hero image above an article. `auto` is not used:
 * it lets the model pick, and a portrait hero on one article in five is worse
 * than a fixed shape.
 */
const SIZE = "1536x1024";

/**
 * WebP at the cheapest quality tier.
 *
 * The product scores its own articles on page speed and then used to ship a
 * full-quality PNG hero, which is the largest thing on the page. WebP at
 * medium compression is a fraction of the bytes for a decorative image nobody
 * zooms into. Quality is "low" because the tier is the price: this runs on
 * every generated article, and a blog hero is not where the money goes.
 */
const OUTPUT_FORMAT = "webp";
const QUALITY = "low";
/**
 * Separate from `quality`, and the one that actually decides file size:
 * `quality` buys rendering compute, compression buys bytes. Left at its
 * default of 100 the first real generation came back a 1.2 MB hero, which is
 * heavier than the article it sits on and would show up in the PageSpeed
 * number this product reports to the customer.
 */
const OUTPUT_COMPRESSION = 70;

const CONTENT_TYPE: Record<string, string> = {
  webp: "image/webp",
  png: "image/png",
  jpeg: "image/jpeg",
};

/** How each preset is described to the generator. One wording per preset, used by every caller. */
export const STYLE_PROMPT: Record<ImageStyle, string> = {
  sketch: "hand-drawn pencil sketch, monochrome line art on a white background",
  watercolor: "soft watercolour painting with visible brush texture and paper grain",
  realistic: "photorealistic editorial photograph, natural light, shallow depth of field",
  illustration: "flat vector illustration, clean geometric shapes, limited palette",
  "brand-text": "bold minimal graphic composition built from the brand colours and abstract letterforms, no legible words",
};

/**
 * What a caller adds beyond the article. All optional; without a style the
 * free-text `brand_style.style` is the only steer, as before 064.
 */
export interface ImageGenerationOptions {
  /**
   * An in-article image rather than the hero: the prompt then describes the
   * passage it sits beside instead of the article as a whole. The body
   * enrichment (lib/content/enrich/images.ts) names the section heading; the
   * editor's regenerate-one-image passes the paragraph as the excerpt.
   */
  section?: { heading?: string; excerpt: string };
  /** The person's own words for what they want changed (editor regenerate). */
  instruction?: string;
  /** `workspace_output_settings.image_style` (or the featured preset). Replaces the free-text style hint. */
  style?: ImageStyle | null;
  /**
   * The cover as a title card: the article title set in type on a plain
   * ground. The one image that may carry text, so the no-text rule is lifted
   * for it and the title is the subject rather than a scene about it.
   */
  titleCover?: boolean;
  /** `workspace_output_settings.brand_color`; named as the accent. Wins over `brand_style.colors`. */
  brandColor?: string | null;
}

export async function generateImage(
  articleTitle: string,
  keyword: string,
  brandStyle?: Record<string, unknown>,
  options: ImageGenerationOptions = {},
): Promise<ImageGenerationResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const client = new OpenAI({ apiKey });

  const styleHints = options.style
    ? `Style: ${STYLE_PROMPT[options.style]}.`
    : brandStyle?.style
      ? `, style: ${brandStyle.style}`
      : "";
  const colorHints = options.brandColor
    ? `Use the brand colour ${options.brandColor} as the dominant accent.`
    : brandStyle?.colors
      ? `, using brand colors: ${brandStyle.colors}`
      : "";

  const subject = options.section
    ? [
        options.section.heading
          ? `Create an illustration for the section "${options.section.heading}" of a blog article about "${keyword}".`
          : `Create an illustration for a passage of the blog article "${articleTitle}", which is about "${keyword}".`,
        options.section.excerpt ? `The passage says: "${options.section.excerpt.trim().slice(0, 400)}".` : "",
        `The image should be clean and suit an editorial article on a professional website.`,
      ]
    : options.titleCover
      ? [
          `Create a cover image for a blog article titled "${articleTitle}".`,
          `The title text "${articleTitle}" is the subject: set it in large, clear, legible type, spelled exactly as given, ` +
            `centred on a plain, uncluttered background${options.brandColor ? ` in the brand colour ${options.brandColor}` : ""}.`,
          `No other words, no scene, no decoration beyond the type and the background.`,
        ]
      : [
          `Create a professional, visually striking featured image for a blog article titled "${articleTitle}".`,
          `The article is about "${keyword}".`,
          `The image should be clean, modern, and suitable as a hero image on a professional website.`,
        ];

  const prompt = [
    ...subject,
    options.titleCover ? `No watermarks.` : `No text or watermarks in the image.`,
    styleHints,
    colorHints,
    options.instruction?.trim()
      ? `Direction from the editor: ${options.instruction.trim().slice(0, 400)}.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  const model = openaiImageModel();
  const response = await client.images.generate({
    model,
    prompt,
    n: 1,
    size: SIZE,
    quality: QUALITY,
    output_format: OUTPUT_FORMAT,
    output_compression: OUTPUT_COMPRESSION,
  });

  const image = response.data?.[0];
  // Deliberately not falling back to `image.url`. A URL here would mean the
  // configured model is a DALL-E one, and silently accepting it would restore
  // the expiring-URL path this module exists to remove.
  if (!image?.b64_json) {
    throw new Error(
      `${model} returned no image data. The gpt-image models return base64; ` +
        `if OPENAI_IMAGE_MODEL is set to a DALL-E model, unset it.`,
    );
  }

  return {
    data: Buffer.from(image.b64_json, "base64"),
    contentType: CONTENT_TYPE[OUTPUT_FORMAT] ?? "image/webp",
    extension: OUTPUT_FORMAT,
    revisedPrompt: image.revised_prompt ?? undefined,
  };
}
