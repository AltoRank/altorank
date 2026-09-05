// ---------------------------------------------------------------------------
// Article body enrichment: the steps between "drafted" and "ready to review"
// ---------------------------------------------------------------------------
//
// The model writes prose. Everything a finished article has beyond prose - a
// table of contents, images between sections, a video where it teaches, a
// chart for the numbers it quotes, a closing pointer to the site, structured
// data for its FAQ - is added here, after the fact, by functions that take
// HTML and return HTML. Deterministic, testable with fixtures, and outside
// the prompt: an instruction the model follows most of the time is not a rule.
//
// Fixed order, because later steps read what earlier ones wrote: ids before
// the TOC that links to them, images before the video so a section gets one
// or the other, the CTA after everything so it is last, the FAQ schema over
// the final text so it describes what will actually publish.
//
// Every step is wrapped: a throw, an empty result or a result half the length
// of its input keeps the previous HTML and records a warning. The body is the
// product; no decoration is allowed to lose it.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { YouTubeVideo } from "@/lib/youtube/search";
import { applyFormat, type FormatFindings } from "./format";
import { addTableOfContents } from "./toc";
import {
  addSectionImages,
  resolveImageStyle,
  storageImageProducer,
  DEFAULT_MAX_IMAGES,
  type ImageProducer,
} from "./images";
import { addHowToVideo } from "./video";
import { addInfographics } from "./infographic";
import { addCallToAction } from "./cta";
import { buildFaqSchema, type FaqSchema } from "./faq";
import type { ImageStyle } from "./labels";

export type { FormatFindings, FaqSchema, ImageStyle };

/**
 * The columns of `workspace_output_settings` this pipeline reads. The table
 * arrives with the onboarding wizard (migration 049); an install without it
 * gets these defaults, which are also the table's own defaults.
 */
export interface EnrichmentSettings {
  tableOfContents: boolean;
  callToAction: boolean;
}

export const DEFAULT_SETTINGS: EnrichmentSettings = {
  tableOfContents: true,
  callToAction: true,
};

export interface EnrichmentReport {
  toc: boolean;
  /** Images this run generated and inserted. Not the article's total. */
  images: number;
  video: boolean;
  infographics: number;
  cta: boolean;
  /** Question/answer pairs in the FAQ schema; 0 when there is none. */
  faq: number;
  warnings: string[];
  format: FormatFindings | null;
  /** The style preset the images were generated in, when any were. */
  imageStyle: ImageStyle | null;
  /** FAQPage JSON-LD for the publishing adapter to inject. Null when the body has no FAQ. */
  faqSchema: FaqSchema | null;
}

export interface EnrichContext {
  workspaceId: string;
  keyword: string;
  title: string;
  /** Needed to store images; without it the image step is skipped. */
  articleId?: string | null;
  /** The generation job, so image spend groups with the run. */
  runId?: string | null;
  domain?: string | null;
  language?: string | null;
  /** Loaded from `workspace_output_settings` when omitted and a client is given. */
  settings?: Partial<EnrichmentSettings> | null;
  brandStyle?: Record<string, unknown> | null;
  /** `business_profile.name`; looked up when omitted and a client is given. */
  businessName?: string | null;
  /** Storage, settings and spend. Omit in tests: every network step then skips. */
  supabase?: SupabaseClient | null;
  /**
   * The research object the caller is about to persist. The report is attached
   * to it as `enrichment`, because `articles.seo_checks` is a typed array the
   * score ring renders item by item and `research` is the jsonb column the
   * caller saves whole. Attaching here keeps the call site to one line.
   */
  research?: Record<string, unknown> | null;
  /** Test seams. Production leaves them unset. */
  imageProducer?: ImageProducer | null;
  maxImages?: number;
  videoSearch?: (query: string) => Promise<YouTubeVideo[]>;
  fetchTitle?: (url: string) => Promise<string | null>;
}

export interface EnrichResult {
  html: string;
  report: EnrichmentReport;
}

/**
 * `workspace_output_settings` for one site, or the defaults when the row or
 * the table is missing. A missing table is a PostgREST error, not a throw, so
 * `data` is null either way and the fallback is the same.
 */
export async function loadEnrichmentSettings(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<EnrichmentSettings> {
  try {
    const { data } = await supabase
      .from("workspace_output_settings")
      .select("table_of_contents, call_to_action")
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (!data) return DEFAULT_SETTINGS;
    return {
      tableOfContents: data.table_of_contents ?? DEFAULT_SETTINGS.tableOfContents,
      callToAction: data.call_to_action ?? DEFAULT_SETTINGS.callToAction,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** `business_profile.name`, on installs that have migration 048; null otherwise. */
async function loadBusinessName(supabase: SupabaseClient, workspaceId: string): Promise<string | null> {
  try {
    const { data } = await supabase
      .from("workspaces")
      .select("business_profile")
      .eq("id", workspaceId)
      .maybeSingle();
    const name = (data?.business_profile as { name?: unknown } | null)?.name;
    return typeof name === "string" && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

/** Write the chosen preset back so the next article's images match this one's. */
async function persistImageStyle(
  supabase: SupabaseClient,
  workspaceId: string,
  brandStyle: Record<string, unknown> | null | undefined,
  style: ImageStyle,
): Promise<void> {
  try {
    await supabase
      .from("workspaces")
      .update({ brand_style: { ...(brandStyle ?? {}), image_style: style } })
      .eq("id", workspaceId);
  } catch {
    // The preset is a convenience; losing it costs consistency, not content.
  }
}

export async function enrichArticle(html: string, ctx: EnrichContext): Promise<EnrichResult> {
  const warnings: string[] = [];
  let current = html;

  /**
   * Run one step over the current HTML and keep its result only when the
   * result is plausibly still the article. Mirrors `enhance` in generate.ts,
   * which learned the hard way that a step returning "" wipes everything
   * downstream.
   */
  async function step<T>(
    label: string,
    run: (input: string) => Promise<{ html: string } & T> | ({ html: string } & T),
    empty: T,
  ): Promise<T> {
    try {
      const result = await run(current);
      if (!result.html || result.html.trim().length < current.trim().length / 2) {
        warnings.push(`${label}: returned ${result.html ? "a suspiciously short result" : "nothing"}; kept the previous HTML`);
        return empty;
      }
      current = result.html;
      return result;
    } catch (err) {
      warnings.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      return empty;
    }
  }

  const supabase = ctx.supabase ?? null;
  const settings: EnrichmentSettings = {
    ...DEFAULT_SETTINGS,
    ...(ctx.settings ?? (supabase ? await loadEnrichmentSettings(supabase, ctx.workspaceId) : {})),
  };
  const businessName =
    ctx.businessName !== undefined
      ? ctx.businessName
      : supabase
        ? await loadBusinessName(supabase, ctx.workspaceId)
        : null;

  // 1. Format: ids, rel, alt, bolded claims, titled links. Everything after
  //    this relies on the ids.
  const format = await step(
    "format",
    (h) => applyFormat(h, { siteDomain: ctx.domain, fetchTitle: ctx.fetchTitle }),
    { findings: null as FormatFindings | null },
  );

  // 2. Table of contents.
  const toc = await step(
    "table of contents",
    (h) => addTableOfContents(h, { enabled: settings.tableOfContents, language: ctx.language }),
    { added: false },
  );

  // 3. Images. The producer is the paid part; without a key, a client or an
  //    article id there is nothing to call and nowhere to store, so skip.
  let imageStyle: ImageStyle | null = null;
  let images: { added: number } = { added: 0 };
  const chosen = resolveImageStyle(ctx.brandStyle);
  const producer =
    ctx.imageProducer !== undefined
      ? ctx.imageProducer
      : supabase && ctx.articleId
        ? storageImageProducer({
            supabase,
            workspaceId: ctx.workspaceId,
            articleId: ctx.articleId,
            keyword: ctx.keyword,
            brandStyle: ctx.brandStyle,
            runId: ctx.runId,
          })
        : null;
  if (producer) {
    imageStyle = chosen.style;
    const result = await step(
      "images",
      (h) =>
        addSectionImages(h, {
          produce: producer,
          max: ctx.maxImages ?? DEFAULT_MAX_IMAGES,
          style: chosen.style,
          language: ctx.language,
        }),
      { added: 0, warnings: [] as string[] },
    );
    images = result;
    warnings.push(...result.warnings);
    if (result.added > 0 && chosen.persist && supabase) {
      await persistImageStyle(supabase, ctx.workspaceId, ctx.brandStyle, chosen.style);
    }
  }

  // 4. Video, for a how-to section.
  const video = await step(
    "video",
    (h) => addHowToVideo(h, { search: ctx.videoSearch, language: ctx.language }),
    { added: false },
  );

  // 5. Infographics, for numbers already in the text.
  const infographics = await step(
    "infographic",
    (h) => addInfographics(h, { language: ctx.language }),
    { added: 0 },
  );

  // 6. Call to action, last in the body.
  const cta = await step(
    "call to action",
    (h) =>
      addCallToAction(h, {
        enabled: settings.callToAction,
        domain: ctx.domain,
        businessName,
        language: ctx.language,
      }),
    { added: false },
  );

  // 7. FAQ schema, read from the final text.
  let faq: { schema: FaqSchema | null; count: number } = { schema: null, count: 0 };
  try {
    faq = buildFaqSchema(current);
  } catch (err) {
    warnings.push(`faq: ${err instanceof Error ? err.message : String(err)}`);
  }

  const report: EnrichmentReport = {
    toc: toc.added,
    images: images.added,
    video: video.added,
    infographics: infographics.added,
    cta: cta.added,
    faq: faq.count,
    warnings,
    format: format.findings,
    imageStyle,
    faqSchema: faq.schema,
  };

  if (ctx.research && typeof ctx.research === "object") {
    ctx.research.enrichment = report;
  }

  return { html: current, report };
}
