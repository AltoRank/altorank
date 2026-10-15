"use server";

import { revalidatePath } from "next/cache";
import { removePendingOverage } from "@/lib/billing/overage";
import { createClient } from "@/lib/supabase/server";
import { LIVE_COLUMNS, purgeArticleImages, wasEverLive, type LiveFacts } from "@/lib/storage/purge";
import { storageAdmin } from "@/lib/storage/admin";
import { requireAuth } from "@/lib/auth/require-auth";
import { z } from "zod";
import { assertEditorialStatus } from "@/lib/articles/editorial-status";
import { sessionBodyLockedForWorkspace } from "@/lib/billing/body-lock";
import { BODY_LOCKED_MESSAGE } from "@/lib/billing/trial-refusal";
import { urlSlug } from "@/lib/i18n/locale";
import { approvalAfterStatusChange, approvalAfterTextEdit } from "@/lib/articles/approval";
import { sanitizeArticleDoc } from "@/lib/html/article-doc";
import { safeUrl } from "@/lib/html/sanitize";

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
): Promise<{ sentBackToReview: boolean }> {
  const { user } = await requireAuth();
  // The editor and the row menu may move an article between editorial states
  // only. Approval, scheduling and publishing have their own actions and the
  // gate in lib/publishing/core.ts trusts status = "approved".
  if (data.status !== undefined) assertEditorialStatus(data.status);
  // The body is checked here, on the server, against the same rules the
  // publish serialiser and the editor apply: every link, image, embed and
  // inline SVG figure in it is held to lib/html/sanitize.ts, and what does not
  // pass is dropped. The client's JSON is never written as it arrived.
  if (data.content !== undefined) data = { ...data, content: sanitizeArticleDoc(data.content) };
  if (data.featured_image_url) {
    const src = safeUrl(data.featured_image_url, "image");
    if (!src) throw new Error("The featured image must be an http(s) address");
    data = { ...data, featured_image_url: src };
  }
  const supabase = await createClient();
  // The editor is what the trial opens. Before it the reads hand the editor
  // an article with its body withheld (lib/billing/body-lock.ts), and a Save
  // from that screen would write the empty document over the real one.
  const { data: row } = await supabase
    .from("articles")
    .select("workspace_id, status, approved_by")
    .eq("id", id)
    .maybeSingle();
  if (!row) throw new Error("Article not found");
  if (await sessionBodyLockedForWorkspace(row.workspace_id as string)) throw new Error(BODY_LOCKED_MESSAGE);

  const now = new Date().toISOString();
  // Change status > Review on an approved or scheduled article used to leave
  // the approval in place and the draft unheld, so the auto-approve rule
  // signed it off again in the next cron run and it published anyway.
  const approval =
    approvalAfterStatusChange({ status: row.status as string }, data.status, user.id, now) ??
    approvalAfterTextEdit(
      { status: row.status as string, approved_by: row.approved_by as string | null },
      data,
      user.id,
      now,
    );
  const { data: written, error } = await supabase
    .from("articles")
    .update({ ...data, ...approval, updated_at: now })
    .eq("id", id)
    // Against the status it was read in, so an approval that lands between
    // the read and this write is not overwritten by a decision made without it.
    .eq("status", row.status as string)
    .select("id");

  if (error) throw new Error(error.message);
  if (!written?.length) throw new Error("This article changed while it was being saved. Reload the page and try again.");
  revalidatePath("/articles");
  revalidatePath(`/content/${id}`);
  return { sentBackToReview: approval?.status === "review" && row.status !== "review" };
}

export async function deleteArticle(id: string) {
  const { accountId } = await requireAuth();
  const supabase = await createClient();
  // Whether it ever reached a reader decides whether its images go with it
  // (lib/storage/purge.ts). Read before the row goes, by the server; nothing
  // is removed unless the person's own delete below succeeds, and an
  // unreadable row keeps its images.
  const admin = storageAdmin();
  const { data: facts } = admin
    ? await admin.from("articles").select(`workspace_id, ${LIVE_COLUMNS}`).eq("id", id).maybeSingle()
    : { data: null };
  // `.select` so the charge below is taken back only for a row this delete
  // really removed (RLS may hide it, which deletes nothing).
  const { data: removed, error } = await supabase.from("articles").delete().eq("id", id).select("id");
  if (error) throw new Error(error.message);
  // The slot comes back with the delete; so does a pending overage charge
  // for this draft, or the next draft would be a second charge for one
  // surviving article.
  if ((removed ?? []).length > 0) {
    await removePendingOverage(supabase, accountId, id);
    const row = facts as (LiveFacts & { workspace_id?: string }) | null;
    if (admin && row?.workspace_id && !wasEverLive(row)) {
      try {
        await purgeArticleImages(admin, row.workspace_id, [id]);
      } catch (err) {
        console.warn(`[article delete] ${id}: draft images not removed:`, err instanceof Error ? err.message : err);
      }
    }
  }
  revalidatePath("/articles");
}
