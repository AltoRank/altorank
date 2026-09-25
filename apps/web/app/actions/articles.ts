"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { z } from "zod";
import { assertEditorialStatus } from "@/lib/articles/editorial-status";
import { sessionBodyLockedForWorkspace } from "@/lib/billing/body-lock";
import { BODY_LOCKED_MESSAGE } from "@/lib/billing/trial-refusal";
import { urlSlug } from "@/lib/i18n/locale";

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

  // The same fold as every other slug: an ASCII-only strip dropped every
  // accented and Turkish letter from a title typed here.
  const slug = urlSlug(parsed.title);

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

export async function updateArticle(
  id: string,
  data: {
    content?: unknown;
    status?: string;
    title?: string;
    seo_score?: number;
    meta_description?: string | null;
    featured_image_url?: string | null;
    word_count?: number;
  },
) {
  await requireAuth();
  // The editor and the row menu may move an article between editorial states
  // only. Approval, scheduling and publishing have their own actions and the
  // gate in lib/publishing/core.ts trusts status = "approved".
  if (data.status !== undefined) assertEditorialStatus(data.status);
  const supabase = await createClient();
  // The editor is what the trial opens. Before it the reads hand the editor
  // an article with its body withheld (lib/billing/body-lock.ts), and a Save
  // from that screen would write the empty document over the real one.
  const { data: row } = await supabase.from("articles").select("workspace_id").eq("id", id).maybeSingle();
  if (!row) throw new Error("Article not found");
  if (await sessionBodyLockedForWorkspace(row.workspace_id as string)) throw new Error(BODY_LOCKED_MESSAGE);
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
