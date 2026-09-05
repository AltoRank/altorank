import OpenAI from "openai";
import { openaiImageModel } from "./models";

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

/**
 * What a caller adds to the default hero prompt. Every field is optional; the
 * generator's own featured-image call passes none.
 *
 *   section      an in-article image rather than the hero (lib/content/enrich/
 *                images.ts): the prompt describes the section it sits beside.
 *   context      the paragraph the image sits beside, when the editor
 *                regenerates one image by hand.
 *   instruction  the person's own words for what they want changed.
 */
export interface ImageGenerationOptions {
  section?: { heading: string; excerpt: string };
  context?: string;
  instruction?: string;
}

/** The editor's name for the same options (#76). */
export type ImageGuidance = Pick<ImageGenerationOptions, "context" | "instruction">;

export async function generateImage(
  articleTitle: string,
  keyword: string,
  brandStyle?: Record<string, unknown>,
  options: ImageGenerationOptions = {},
): Promise<ImageGenerationResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const client = new OpenAI({ apiKey });

  const styleHints = brandStyle?.style ? `, style: ${brandStyle.style}` : "";
  const colorHints = brandStyle?.colors
    ? `, using brand colors: ${brandStyle.colors}`
    : "";

  const subject = options.section
    ? [
        `Create an illustration for the section "${options.section.heading}" of a blog article about "${keyword}".`,
        options.section.excerpt ? `The section says: "${options.section.excerpt}".` : "",
        `The image should be clean and suit an editorial article on a professional website.`,
      ]
    : [
        `Create a professional, visually striking featured image for a blog article titled "${articleTitle}".`,
        `The article is about "${keyword}".`,
        options.context?.trim()
          ? `It illustrates this passage: "${options.context.trim().slice(0, 400)}".`
          : "",
        `The image should be clean, modern, and suitable as a hero image on a professional website.`,
      ];

  const prompt = [
    ...subject,
    `No text or watermarks in the image.`,
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
