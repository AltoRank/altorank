// ---------------------------------------------------------------------------
// Article generation, one implementation
// ---------------------------------------------------------------------------
//
// Used by two callers that differ only in whether a human is watching:
//
//   POST /api/generate      streams to an editor, passes `onChunk`
//   GET  /api/cron/generate unattended, no callback
//
// The alternative was a second copy of this in the cron. Today's session found
// four separate bugs that existed only because two code paths were meant to do
// the same thing and drifted, so the streaming hook is the whole difference and
// everything else is shared by construction.

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveProvider } from "@/lib/ai/provider";
import { htmlToTiptapJson } from "@/lib/ai/tiptap";
import { factCheckArticle, type FactCheckReport } from "@/lib/ai/fact-check";
import { embedYouTubeVideos } from "@/lib/ai/video-embedder";
import { generateImage } from "@/lib/ai/image-generator";
import { uploadImageFromUrl } from "@/lib/storage/images";
import { resolveInternalLinks } from "@/lib/seo/link-resolver";
import { gatherArticleResearch, type ArticleResearch } from "@/lib/seo/research";
import { getLocale } from "@/lib/seo/locales";
import type { VoiceRules } from "@/lib/ai/types";

export interface GenerateArticleOptions {
  supabase: SupabaseClient;
  workspaceId: string;
  keyword: string;
  title?: string;
  /** Marks the draft as machine-chosen, so a reviewer can tell. */
  autonomous?: boolean;
  /**
   * The recommendation this draft came from, when it came from the autonomous
   * queue. Persisted so the reviewer can see why the machine chose this term
   * without re-deriving it, which would answer a different question: keyword
   * data moves, so a recomputed reason is the reason it would be picked NOW,
   * not the reason it was picked then. Omitted for manual generation.
   */
  selection?: {
    reasons: string[];
    score: number;
    difficulty: number | null;
  };
  /** Streaming hook. Omitted by the unattended path. */
  onChunk?: (html: string) => void;
  /** Called once research completes, before the model starts. */
  onResearch?: (research: ArticleResearch) => void;
}

export interface GenerateArticleResult {
  articleId: string;
  jobId: string;
  title: string;
  wordCount: number;
  tokensUsed: number;
  research: ArticleResearch;
  factCheck: FactCheckReport;
}

export async function generateArticle(
  options: GenerateArticleOptions,
): Promise<GenerateArticleResult> {
  const { supabase, workspaceId, keyword, title, autonomous, onChunk, onResearch,
    selection,
  } = options;

  const { data: workspace, error: wsError } = await supabase
    .from("workspaces")
    .select("id, ai_provider, ai_model, agency_id, language, brand_style")
    .eq("id", workspaceId)
    .single();

  if (wsError || !workspace) throw new Error("Workspace not found");

  const { data: voiceProfile } = await supabase
    .from("voice_profiles")
    .select("rules")
    .eq("workspace_id", workspaceId)
    .single();

  const voiceRules = (voiceProfile?.rules as VoiceRules) ?? undefined;

  const slug = (title || keyword)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

  const { data: article, error: articleError } = await supabase
    .from("articles")
    .insert({
      workspace_id: workspaceId,
      title: title || keyword,
      slug,
      keyword,
      status: "drafting",
      ai_provider: workspace.ai_provider || "claude",
      generated_autonomously: autonomous ?? false,
    })
    .select("id")
    .single();

  if (articleError || !article) {
    throw new Error(`Failed to create article: ${articleError?.message}`);
  }

  const { data: job, error: jobError } = await supabase
    .from("generation_jobs")
    .insert({
      workspace_id: workspaceId,
      article_id: article.id,
      status: "running",
      ai_provider: workspace.ai_provider || "claude",
      prompt_config: { keyword, title, voiceRules, autonomous: autonomous ?? false },
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (jobError || !job) {
    await supabase.from("articles").delete().eq("id", article.id);
    throw new Error(`Failed to create generation job: ${jobError?.message}`);
  }

  try {
    const locale = getLocale(workspace.language ?? "en");

    const research = await gatherArticleResearch({
      keyword,
      locale: workspace.language ?? "en",
      supabase,
      workspaceId,
    });
    onResearch?.(research);

    const provider = resolveProvider(workspace.ai_provider, workspace.ai_model);
    const generator = provider.streamArticle({
      keyword,
      title,
      voiceRules,
      language: locale.label,
      research,
    });

    let articleResult;
    while (true) {
      const next = await generator.next();
      if (next.done) {
        articleResult = next.value;
        break;
      }
      onChunk?.(next.value);
    }
    if (!articleResult) throw new Error("Generator ended without returning a result");

    let processedHtml = articleResult.html;
    try {
      processedHtml = await embedYouTubeVideos(processedHtml, keyword);
    } catch {
      // Video embedding is optional.
    }

    try {
      processedHtml = await resolveInternalLinks(supabase, processedHtml, workspaceId, article.id);
    } catch {
      // Link resolution is non-blocking.
    }

    const factCheck = factCheckArticle(processedHtml, research);
    const tiptapContent = htmlToTiptapJson(processedHtml);

    let featuredImageUrl: string | null = null;
    try {
      if (process.env.OPENAI_API_KEY) {
        const imageResult = await generateImage(
          articleResult.title,
          keyword,
          workspace.brand_style as Record<string, unknown> | undefined,
        );
        featuredImageUrl = await uploadImageFromUrl(
          supabase,
          imageResult.url,
          `${workspaceId}/${article.id}.png`,
        );
      }
    } catch {
      // Image generation is optional.
    }

    await supabase
      .from("articles")
      .update({
        content: tiptapContent,
        title: articleResult.title,
        meta_description: articleResult.metaDescription,
        word_count: articleResult.wordCount,
        featured_image_url: featuredImageUrl,
        research,
        fact_checks: factCheck,
        search_intent: research.intent.intent,
        fact_check_verdict: factCheck.verdict,
        // Null for manual generation; the reviewer then sees "you picked this"
        // rather than a fabricated rationale.
        selection_reasons: selection?.reasons ?? null,
        selection_score: selection?.score ?? null,
        // Deliberately not `?? 0`. Unmeasured difficulty is not zero difficulty.
        keyword_difficulty: selection?.difficulty ?? null,
        // Always `review`, never `approved` or `scheduled`. The approval gate is
        // the point: a machine may write, a human decides whether it ships.
        status: "review",
        updated_at: new Date().toISOString(),
      })
      .eq("id", article.id);

    await supabase
      .from("generation_jobs")
      .update({
        status: "completed",
        tokens_used: articleResult.tokensUsed,
        result: { wordCount: articleResult.wordCount, title: articleResult.title },
        completed_at: new Date().toISOString(),
      })
      .eq("id", job.id);

    return {
      articleId: article.id,
      jobId: job.id,
      title: articleResult.title,
      wordCount: articleResult.wordCount,
      tokensUsed: articleResult.tokensUsed,
      research,
      factCheck,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown generation error";

    await supabase
      .from("articles")
      .update({ status: "error", updated_at: new Date().toISOString() })
      .eq("id", article.id);

    await supabase
      .from("generation_jobs")
      .update({ status: "failed", error: message, completed_at: new Date().toISOString() })
      .eq("id", job.id);

    throw err;
  }
}
