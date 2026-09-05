// ---------------------------------------------------------------------------
// Step 3: images inside the article
// ---------------------------------------------------------------------------
//
// The featured image already exists (generate.ts, lib/ai/image-generator). This
// puts two to four more into the body, one before a major section, generated
// from that section's heading and opening paragraph so the picture is about
// what the reader is about to read. The same generator, the same bucket, the
// same brand style; the only new thing is where the prompt comes from.
//
// Spend is the constraint. Every image is a paid call, so the count is capped
// (three by default), the step skips entirely without a key or under
// `E2E_STUBS`, and the generator is injected so tests never pay.

import type { SupabaseClient } from "@supabase/supabase-js";
import { generateImage } from "@/lib/ai/image-generator";
import { openaiImageModel } from "@/lib/ai/models";
import { uploadImageBuffer } from "@/lib/storage/images";
import { recordSpend } from "@/lib/billing/spend";
import { labelsFor, type ImageStyle } from "./labels";
import {
  splitSections,
  firstParagraph,
  stripTags,
  firstSentence,
  truncate,
  wordCount,
  escapeAttr,
  escapeHtml,
} from "./html";

export const IMAGE_STYLES: ImageStyle[] = ["sketch", "watercolor", "realistic", "illustration", "brand-text"];

export const DEFAULT_MAX_IMAGES = 3;

/** What the generator is asked for, per image. */
export interface ImageBrief {
  heading: string;
  excerpt: string;
  style: ImageStyle;
}

/** Returns the public URL of the stored image, or null to skip this slot. */
export type ImageProducer = (brief: ImageBrief, index: number) => Promise<string | null>;

export interface ImagesOptions {
  produce: ImageProducer;
  /** Hard cap on generated images for this article. */
  max?: number;
  style?: ImageStyle;
  language?: string | null;
  /** A section shorter than this is not major enough to illustrate. */
  minSectionWords?: number;
}

/**
 * The style preset for a workspace, from `brand_style.image_style` when it is
 * set and otherwise inferred from the free-text `brand_style.style` the
 * featured-image prompt already reads. `persist` says whether the caller
 * should write the choice back so every later image agrees with this one.
 */
export function resolveImageStyle(
  brandStyle: Record<string, unknown> | null | undefined,
): { style: ImageStyle; persist: boolean } {
  const stored = brandStyle?.image_style;
  if (typeof stored === "string" && (IMAGE_STYLES as string[]).includes(stored)) {
    return { style: stored as ImageStyle, persist: false };
  }
  const hint = typeof brandStyle?.style === "string" ? brandStyle.style.toLowerCase() : "";
  let style: ImageStyle = "illustration";
  if (/sketch|line ?art|hand[- ]?drawn|pencil/.test(hint)) style = "sketch";
  else if (/watercolou?r|aquarell/.test(hint)) style = "watercolor";
  else if (/photo|realis/.test(hint)) style = "realistic";
  else if (/typograph|lettering|text/.test(hint)) style = "brand-text";
  return { style, persist: true };
}

/** How each preset is described to the generator. */
export const STYLE_PROMPT: Record<ImageStyle, string> = {
  sketch: "hand-drawn pencil sketch, monochrome line art on a white background",
  watercolor: "soft watercolour painting with visible brush texture and paper grain",
  realistic: "photorealistic editorial photograph, natural light, shallow depth of field",
  illustration: "flat vector illustration, clean geometric shapes, limited palette",
  "brand-text": "bold minimal graphic composition built from the brand colours and abstract letterforms, no legible words",
};

/**
 * Where images go: before the H2 of each chosen section, chosen so they are
 * spread through the article and never adjacent. Sections already carrying a
 * figure, and short ones, are not candidates.
 */
/**
 * Sections that summarise or list rather than explain. An image drawn from
 * "Key takeaways" or "FAQ" illustrates nothing in particular.
 */
const NOT_ILLUSTRATED =
  /key takeaways?|summary|tl;?dr|conclusion|final thoughts|\bfaqs?\b|frequently asked|domande frequenti|preguntas frecuentes|references|sources|further reading/i;

export function chooseInsertionPoints(
  sections: { body: string; headingText?: string }[],
  max: number,
  minSectionWords = 80,
): number[] {
  const candidates = sections
    .map((s, i) => ({ i, s }))
    .filter(
      ({ s }) =>
        !/<(img|iframe|svg)\b/i.test(s.body) &&
        !NOT_ILLUSTRATED.test(s.headingText ?? "") &&
        wordCount(s.body) >= minSectionWords,
    )
    .map(({ i }) => i);
  if (!candidates.length || max <= 0) return [];
  if (candidates.length <= max) {
    return dropAdjacent(candidates);
  }
  // Even spread: first candidate, then every (n/max)th.
  const step = candidates.length / max;
  const picked = new Set<number>();
  for (let k = 0; k < max; k++) picked.add(candidates[Math.min(candidates.length - 1, Math.floor(k * step))]);
  return dropAdjacent([...picked].sort((a, b) => a - b));
}

function dropAdjacent(indices: number[]): number[] {
  const out: number[] = [];
  for (const i of indices) {
    if (out.length && i - out[out.length - 1] < 2) continue;
    out.push(i);
  }
  return out;
}

export function renderImageFigure(url: string, alt: string, caption: string): string {
  return (
    `<figure class="article-image">` +
    `<img src="${escapeAttr(url)}" alt="${escapeAttr(alt)}" loading="lazy">` +
    `<figcaption>${escapeHtml(caption)}</figcaption>` +
    `</figure>`
  );
}

export async function addSectionImages(
  html: string,
  opts: ImagesOptions,
): Promise<{ html: string; added: number; warnings: string[] }> {
  const max = opts.max ?? DEFAULT_MAX_IMAGES;
  const existing = (html.match(/<img\b/gi) ?? []).length;
  if (existing >= max) return { html, added: 0, warnings: [] };

  const { intro, sections } = splitSections(html);
  const points = chooseInsertionPoints(sections, max - existing, opts.minSectionWords);
  if (!points.length) return { html, added: 0, warnings: [] };

  const labels = labelsFor(opts.language);
  const style = opts.style ?? "illustration";
  const warnings: string[] = [];
  const figures = new Map<number, string>();

  // Sequential, not parallel: the cap is a spend cap, and a producer that
  // starts failing should stop the run rather than fire the remaining calls.
  for (const [n, i] of points.entries()) {
    const section = sections[i];
    const p = firstParagraph(section.body);
    const excerpt = truncate(stripTags(p?.inner ?? ""), 300);
    try {
      const url = await opts.produce({ heading: section.headingText, excerpt, style }, n);
      if (!url) break;
      // Alt text names the subject the image was drawn for, in the style it
      // was drawn in. The caption is the section heading: a fact about where
      // the image sits, not a claim about what it depicts.
      const alt = `${labels.illustration[style]} ${section.headingText}`;
      // A sentence that introduces a list ("...describe the fuller arc:") is
      // not a caption; the heading is.
      const sentence = firstSentence(excerpt);
      const caption =
        sentence && sentence.length <= 140 && /[.!?]$/.test(sentence) ? sentence : section.headingText;
      figures.set(i, renderImageFigure(url, alt, caption));
    } catch (err) {
      warnings.push(`image ${n + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
  }

  if (!figures.size) return { html, added: 0, warnings };
  const out =
    intro +
    sections.map((s, i) => (figures.has(i) ? `${figures.get(i)}\n` : "") + s.heading + s.body).join("");
  return { html: out, added: figures.size, warnings };
}

/**
 * The real producer: the featured-image generator with a section brief, the
 * article bucket, and a spend row per image. Returns null (skip) rather than
 * throwing when nothing is configured.
 */
export function storageImageProducer(args: {
  supabase: SupabaseClient;
  workspaceId: string;
  articleId: string;
  keyword: string;
  brandStyle: Record<string, unknown> | null | undefined;
  runId?: string | null;
}): ImageProducer | null {
  if (!process.env.OPENAI_API_KEY || process.env.E2E_STUBS) return null;
  const { supabase, workspaceId, articleId, keyword, brandStyle, runId } = args;
  return async (brief, index) => {
    const result = await generateImage(brief.heading, keyword, {
      ...(brandStyle ?? {}),
      style: STYLE_PROMPT[brief.style],
    }, { section: { heading: brief.heading, excerpt: brief.excerpt } });
    // The images endpoint reports no price, so cost stays null rather than a
    // guess: an unmeasured number is not a zero.
    void recordSpend(supabase, {
      provider: "openai",
      operation: `${openaiImageModel()} (section image)`,
      costUsd: null,
      workspaceId,
      articleId,
      runId: runId ?? null,
    });
    return uploadImageBuffer(
      supabase,
      result.data,
      `${workspaceId}/${articleId}-${index + 1}.${result.extension}`,
      result.contentType,
    );
  };
}
