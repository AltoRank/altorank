"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { getValidAccessToken } from "@/lib/google/oauth";
import { GSCApiError, inspectUrl } from "@/lib/google/gsc";
import { parseInspection, type UrlInspection } from "@/lib/google/inspection";
import { resolveGscSiteUrl } from "@/lib/google/sync";

export type CheckIndexingResult =
  | { ok: true; inspection: UrlInspection }
  | { ok: false; reason: "not_published" | "not_connected" | "no_property" | "forbidden" | "error"; message: string };

/**
 * Ask Google whether one article's URL is in its index, and keep the answer.
 *
 * On demand, never in a loop: the inspection quota is per property per day
 * and a person clicking on one article is what it is sized for. The result
 * lands in `articles.indexing_status.inspection` beside the IndexNow and
 * sitemap results already stored there, and the editor, the Articles list
 * and the dashboard's coverage block all read that one field.
 *
 * Every failure is a sentence rather than a silent "Unknown": which of
 * "not published", "Search Console not connected", "no property for this
 * domain" or "Google refused" it was decides what the person does next.
 */
export async function checkIndexing(articleId: string): Promise<CheckIndexingResult> {
  await requireAuth();
  const supabase = await createClient();

  const { data: article, error } = await supabase
    .from("articles")
    .select("id, workspace_id, published_url, indexing_status")
    .eq("id", articleId)
    .single();
  if (error || !article) return { ok: false, reason: "error", message: "Article not found." };
  if (!article.published_url) {
    return { ok: false, reason: "not_published", message: "This article has no published URL yet; Google can only be asked about a live page." };
  }

  const { data: integration } = await supabase
    .from("workspace_integrations")
    .select("id, config, tokens, workspace:workspaces(id, domain)")
    .eq("workspace_id", article.workspace_id)
    .eq("integration_id", "gsc")
    .maybeSingle();
  const encrypted = (integration?.tokens as { encrypted?: string } | null)?.encrypted;
  if (!integration || !encrypted) {
    return { ok: false, reason: "not_connected", message: "Search Console is not connected for this workspace, so there is nothing to ask." };
  }
  const workspace = integration.workspace as unknown as { id: string; domain: string | null } | null;
  if (!workspace?.domain) {
    return { ok: false, reason: "no_property", message: "This workspace has no domain, so no Search Console property can be matched to it." };
  }

  try {
    const accessToken = await getValidAccessToken(encrypted, async (next) => {
      await supabase.from("workspace_integrations").update({ tokens: { encrypted: next } }).eq("id", integration.id);
    });
    const siteUrl = await resolveGscSiteUrl(
      supabase,
      { id: integration.id, config: (integration.config as { gscSiteUrl?: string } | null) ?? null },
      workspace.domain,
      accessToken,
    );
    const body = await inspectUrl(accessToken, siteUrl, article.published_url);
    const inspection = parseInspection(body, new Date().toISOString());

    const existing = (article.indexing_status as Record<string, unknown> | null) ?? {};
    const { error: writeError } = await supabase
      .from("articles")
      .update({ indexing_status: { ...existing, inspection } })
      .eq("id", articleId);
    if (writeError) return { ok: false, reason: "error", message: writeError.message };

    revalidatePath("/articles");
    revalidatePath(`/content/${articleId}`);
    revalidatePath("/dashboard");
    return { ok: true, inspection };
  } catch (err) {
    if (err instanceof GSCApiError && err.status === 403) {
      return {
        ok: false,
        reason: "forbidden",
        message: "Google refused the inspection for this property. The connected account needs owner or full access to it; reconnect Search Console with an account that has it.",
      };
    }
    return { ok: false, reason: "error", message: err instanceof Error ? err.message : "Unknown error" };
  }
}
