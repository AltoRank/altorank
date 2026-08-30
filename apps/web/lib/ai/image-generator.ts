import OpenAI from "openai";
import { openaiImageModel } from "./models";

export interface ImageGenerationResult {
  url: string;
  revisedPrompt?: string;
}

/**
 * Generate a featured image using DALL-E 3.
 * Returns the temporary OpenAI URL — caller should download + re-host.
 */
export async function generateImage(
  articleTitle: string,
  keyword: string,
  brandStyle?: Record<string, unknown>,
): Promise<ImageGenerationResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const client = new OpenAI({ apiKey });

  const styleHints = brandStyle?.style
    ? `, style: ${brandStyle.style}`
    : "";

  const colorHints = brandStyle?.colors
    ? `, using brand colors: ${brandStyle.colors}`
    : "";

  const prompt = [
    `Create a professional, visually striking featured image for a blog article titled "${articleTitle}".`,
    `The article is about "${keyword}".`,
    `The image should be clean, modern, and suitable as a hero image on a professional website.`,
    `No text or watermarks in the image.`,
    styleHints,
    colorHints,
  ]
    .filter(Boolean)
    .join(" ");

  const response = await client.images.generate({
    model: openaiImageModel(),
    prompt,
    n: 1,
    size: "1792x1024",
    quality: "standard",
  });

  const imageData = response.data?.[0];
  if (!imageData?.url) throw new Error("DALL-E returned no image URL");

  return {
    url: imageData.url,
    revisedPrompt: imageData.revised_prompt ?? undefined,
  };
}
