"use server";

import { createClient } from "@/lib/supabase/server";

// ---------------------------------------------------------------------------
// Server actions for AI content generation
// ---------------------------------------------------------------------------

/**
 * Create article + generation job rows in Supabase.
 * Returns the IDs so the client can open an SSE stream to /api/generate or
 * poll for status.
 */
export async function triggerGeneration(
  workspaceId: string,
  keyword: string,
  title?: string
): Promise<{ articleId: string; jobId: string }> {
  const supabase = await createClient();

  // Auth check
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    throw new Error("Unauthorized");
  }

  // Fetch workspace to get AI provider settings
  const { data: workspace, error: wsError } = await supabase
    .from("workspaces")
    .select("id, ai_provider, ai_model, agency_id")
    .eq("id", workspaceId)
    .single();

  if (wsError || !workspace) {
    throw new Error("Workspace not found");
  }

  // Verify membership
  const { data: membership } = await supabase
    .from("agency_members")
    .select("id")
    .eq("agency_id", workspace.agency_id)
    .eq("user_id", user.id)
    .single();

  if (!membership) {
    throw new Error("Forbidden");
  }

  // Fetch voice profile (optional)
  const { data: voiceProfile } = await supabase
    .from("voice_profiles")
    .select("rules")
    .eq("workspace_id", workspaceId)
    .single();

  const slug = (title || keyword)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

  // Create article
  const { data: article, error: articleError } = await supabase
    .from("articles")
    .insert({
      workspace_id: workspaceId,
      title: title || keyword,
      slug,
      keyword,
      status: "drafting",
      ai_provider: workspace.ai_provider || "claude",
    })
    .select("id")
    .single();

  if (articleError || !article) {
    throw new Error(`Failed to create article: ${articleError?.message}`);
  }

  // Create generation job
  const { data: job, error: jobError } = await supabase
    .from("generation_jobs")
    .insert({
      workspace_id: workspaceId,
      article_id: article.id,
      status: "pending",
      ai_provider: workspace.ai_provider || "claude",
      prompt_config: {
        keyword,
        title,
        voiceRules: voiceProfile?.rules ?? null,
      },
    })
    .select("id")
    .single();

  if (jobError || !job) {
    // Clean up article
    await supabase.from("articles").delete().eq("id", article.id);
    throw new Error(`Failed to create generation job: ${jobError?.message}`);
  }

  return { articleId: article.id, jobId: job.id };
}

/**
 * Fetch the current status of a generation job.
 */
export async function getGenerationStatus(jobId: string): Promise<{
  status: string;
  error: string | null;
  tokensUsed: number;
  result: Record<string, unknown> | null;
}> {
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    throw new Error("Unauthorized");
  }

  const { data: job, error: jobError } = await supabase
    .from("generation_jobs")
    .select("status, error, tokens_used, result")
    .eq("id", jobId)
    .single();

  if (jobError || !job) {
    throw new Error("Job not found");
  }

  return {
    status: job.status,
    error: job.error,
    tokensUsed: job.tokens_used,
    result: job.result,
  };
}
