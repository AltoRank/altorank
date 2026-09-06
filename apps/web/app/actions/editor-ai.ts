"use server";

import { z } from "zod";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { rewriteField, type MicroAction, type MicroField } from "@/lib/ai/micro";
import { generateImage } from "@/lib/ai/image-generator";
import { outputFromRow, resolveFeaturedImage, type OutputSettingsRow } from "@/lib/onboarding/output-settings";
import { uploadImageBuffer } from "@/lib/storage/images";
import { renderArticleMarkdown } from "@/lib/publishing/export";

// ---------------------------------------------------------------------------
// The editor's AI actions
// ---------------------------------------------------------------------------
//
// Every one of these returns a proposal and writes nothing to the article.
// The editor shows it next to the current value; accepting it stages it; the
// Save button (updateArticle) is the only write. The one thing that does
// persist is an image file in storage, because a proposed image has to live
// somewhere to be looked at. Discarding it deletes the file.

const microSchema = z.object({
  articleId: z.string().uuid(),
  field: z.enum(["title", "meta_description", "selection"]),
  action: z.enum(["improve", "shorten", "expand", "simplify", "grammar", "ask"]),
  text: z.string().min(1).max(20_000),
  prompt: z.string().max(2_000).optional(),
  outline: z.array(z.string().max(300)).max(40).optional(),
});

export type MicroActionResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/**
 * Load the article through the caller's own client, so RLS answers whether
 * they may see it. Returns the few columns the prompts read.
 */
async function loadArticle(articleId: string) {
  const supabase = await createClient();
  const { data: article } = await supabase
    .from("articles")
    .select("id, workspace_id, title, keyword, slug, meta_description, featured_image_url, published_at")
    .eq("id", articleId)
    .single();
  if (!article) throw new Error("Article not found");
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id, domain, brand_style")
    .eq("id", article.workspace_id)
    .single();
  if (!workspace) throw new Error("Workspace not found");
  return { article, workspace, supabase };
}

export async function rewriteFieldAction(input: {
  articleId: string;
  field: MicroField;
  action: MicroAction;
  text: string;
  prompt?: string;
  outline?: string[];
}): Promise<MicroActionResult> {
  try {
    await requireAuth();
    const parsed = microSchema.parse(input);
    const { article } = await loadArticle(parsed.articleId);
    const result = await rewriteField({
      field: parsed.field,
      action: parsed.action,
      text: parsed.text,
      prompt: parsed.prompt,
      context: { keyword: article.keyword, title: article.title, outline: parsed.outline },
    });
    return { ok: true, text: result.text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Rewrite failed" };
  }
}

// --- Images ------------------------------------------------------------------

export type ImageProposalResult =
  | { ok: true; url: string; path: string }
  | { ok: false; error: string };

/**
 * Proposed images live under `<workspace>/<article>/proposals/` so a discard
 * can delete them and an orphan is recognisable for what it is.
 */
function proposalPath(workspaceId: string, articleId: string, extension: string): string {
  return `${workspaceId}/${articleId}/proposals/${Date.now()}.${extension}`;
}

const regenerateSchema = z.object({
  articleId: z.string().uuid(),
  /** The paragraph beside an in-body image; empty for the featured image. */
  context: z.string().max(2_000).optional(),
  /** "Ask AI": what the person wants in the picture. */
  instruction: z.string().max(1_000).optional(),
});

export async function regenerateImageAction(input: {
  articleId: string;
  context?: string;
  instruction?: string;
}): Promise<ImageProposalResult> {
  try {
    await requireAuth();
    const parsed = regenerateSchema.parse(input);
    const { article, workspace, supabase } = await loadArticle(parsed.articleId);

    // The same presets generation used, so a regenerated image matches its
    // neighbours: the body preset beside a paragraph, the featured preset for
    // the cover.
    const { data: outputRow } = await supabase
      .from("workspace_output_settings")
      .select("*")
      .eq("workspace_id", workspace.id)
      .maybeSingle();
    const settings = outputFromRow(outputRow as OutputSettingsRow | null);
    const isBody = Boolean(parsed.context?.trim());
    const featured = resolveFeaturedImage(settings);

    const image = await generateImage(
      article.title,
      article.keyword,
      (workspace.brand_style ?? undefined) as Record<string, unknown> | undefined,
      {
        section: isBody ? { excerpt: parsed.context! } : undefined,
        instruction: parsed.instruction,
        style: isBody ? settings.imageStyle : featured.style,
        titleCover: isBody ? false : featured.titleCover,
        brandColor: settings.brandColor,
      },
    );
    const path = proposalPath(workspace.id, article.id, image.extension);
    // The bucket only has a public-read policy; writes go through the service
    // role, as the generator's do.
    const url = await uploadImageBuffer(createServiceClient(), image.data, path, image.contentType);
    return { ok: true, url, path };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Image generation failed" };
  }
}

const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpeg",
};
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** A file the person picked. Same bucket, same proposal path, same rules. */
export async function uploadArticleImageAction(formData: FormData): Promise<ImageProposalResult> {
  try {
    await requireAuth();
    const articleId = z.string().uuid().parse(formData.get("articleId"));
    const file = formData.get("file");
    if (!(file instanceof File)) throw new Error("No file");
    const extension = ALLOWED_IMAGE_TYPES[file.type];
    if (!extension) throw new Error("Use a WebP, PNG or JPEG");
    if (file.size > MAX_IMAGE_BYTES) throw new Error("Images are capped at 10 MB");

    const { article, workspace } = await loadArticle(articleId);
    const path = proposalPath(workspace.id, article.id, extension);
    const url = await uploadImageBuffer(
      createServiceClient(),
      Buffer.from(await file.arrayBuffer()),
      path,
      file.type,
    );
    return { ok: true, url, path };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Upload failed" };
  }
}

/** Discarding a proposed image removes the file. Best effort; never blocks. */
export async function discardProposedImageAction(input: { articleId: string; path: string }): Promise<void> {
  try {
    await requireAuth();
    const articleId = z.string().uuid().parse(input.articleId);
    // Only this article's own proposals: the path is client-supplied.
    const { article, workspace } = await loadArticle(articleId);
    const prefix = `${workspace.id}/${article.id}/proposals/`;
    if (!input.path.startsWith(prefix)) return;
    await createServiceClient().storage.from("article-images").remove([input.path]);
  } catch {
    // An orphaned file in a public bucket is a cost, not a leak.
  }
}

// --- Export ------------------------------------------------------------------

/**
 * The article as the Markdown file a git publish would commit, rendered on
 * the server from the HTML the editor is showing. Same converter as
 * lib/cms/git.ts, through lib/publishing/export.ts.
 */
export async function renderMarkdownAction(input: {
  articleId: string;
  html: string;
  title?: string;
  metaDescription?: string | null;
  featuredImageUrl?: string | null;
}): Promise<{ ok: true; markdown: string; filename: string } | { ok: false; error: string }> {
  try {
    await requireAuth();
    const articleId = z.string().uuid().parse(input.articleId);
    const html = z.string().max(2_000_000).parse(input.html);
    const { article, workspace } = await loadArticle(articleId);
    const markdown = renderArticleMarkdown(
      {
        title: input.title ?? article.title,
        slug: article.slug,
        html,
        metaDescription: input.metaDescription === undefined ? article.meta_description : input.metaDescription,
        keyword: article.keyword,
        featuredImageUrl:
          input.featuredImageUrl === undefined ? article.featured_image_url : input.featuredImageUrl,
        publishedAt: article.published_at,
      },
      `https://${workspace.domain}`,
    );
    return { ok: true, markdown, filename: `${article.slug || "article"}.md` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Export failed" };
  }
}
