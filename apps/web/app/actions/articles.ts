"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { z } from "zod";

const createArticleSchema = z.object({
  workspace_id: z.string().uuid(),
  title: z.string().min(1),
  keyword: z.string().optional(),
  cms: z.string().optional(),
});

export async function createArticle(formData: FormData) {
  await requireAuth();
  const supabase = await createClient();
  const parsed = createArticleSchema.parse({
    workspace_id: formData.get("workspace_id"),
    title: formData.get("title"),
    keyword: formData.get("keyword"),
    cms: formData.get("cms"),
  });

  const slug = parsed.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

  // Auto-fill cms from workspace integration if not explicitly set
  let cms = parsed.cms;
  if (!cms) {
    const { data: wsIntegrations } = await supabase
      .from("workspace_integrations")
      .select("*, integration:integrations(*)")
      .eq("workspace_id", parsed.workspace_id);

    const cmsIntegration = wsIntegrations?.find(
      (wi: { integration?: { tag?: string } }) => wi.integration?.tag === "CMS"
    );

    if (cmsIntegration?.config && typeof cmsIntegration.config === "object" && "type" in cmsIntegration.config) {
      cms = cmsIntegration.config.type as string;
    }
  }

  const { error } = await supabase
    .from("articles")
    .insert({ ...parsed, cms, slug, status: "draft" });

  if (error) throw new Error(error.message);
  revalidatePath("/articles");
}

export async function updateArticle(id: string, data: { content?: unknown; status?: string; title?: string; seo_score?: number }) {
  await requireAuth();
  const supabase = await createClient();
  const { error } = await supabase
    .from("articles")
    .update({ ...data, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) throw new Error(error.message);
  revalidatePath("/articles");
  revalidatePath(`/content/${id}`);
}

export async function deleteArticle(id: string) {
  await requireAuth();
  const supabase = await createClient();
  const { error } = await supabase.from("articles").delete().eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/articles");
}
