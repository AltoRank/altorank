// ---------------------------------------------------------------------------
// The one write to a site the refresh engine ever makes
// ---------------------------------------------------------------------------
//
// Everything before this point proposes. This applies a reviewer's hunk
// decisions to produce the final body, hands it to the CMS adapter that
// already holds the post, and records the outcome. It refuses to run unless
// the execution is still awaiting review and at least one hunk was kept, and
// it refuses adapters that cannot edit in place rather than publishing a
// second copy of the page.

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveCMSAdapter } from "@/lib/cms/adapter";
import { canUpdate } from "@/lib/cms/types";
import { htmlToTiptapJson } from "@/lib/ai/tiptap";
import { htmlToMarkdown } from "@/lib/audit/markdown";
import { decryptConfig } from "@/lib/crypto";
import { chooseDestination, toDestinations, type IntegrationRow } from "@/lib/publishing/destinations";
import type { CMSConfig } from "@/lib/types";
import { applyDecisions, readDecisions, summarizeDecisions } from "./hunks";
import type { ExecutionSide, Hunk, RefreshCandidate, RefreshExecution } from "./types";

/** Adapter types that implement `update`. Mirrors the adapters, for the UI. */
export const UPDATABLE_CMS = new Set(["wordpress", "ghost", "webflow", "webhook", "git"]);

interface LoadedExecution {
  execution: RefreshExecution;
  candidate: RefreshCandidate;
}

async function loadExecution(supabase: SupabaseClient, executionId: string): Promise<LoadedExecution> {
  const { data: execution } = await supabase
    .from("refresh_executions")
    .select("*, task:refresh_tasks(candidate:refresh_candidates(*))")
    .eq("id", executionId)
    .maybeSingle();
  if (!execution) throw new Error("Execution not found");
  const candidate = (execution.task as { candidate?: RefreshCandidate } | null)?.candidate ?? null;
  if (!candidate) throw new Error("The candidate behind this execution is gone");
  return { execution: execution as unknown as RefreshExecution, candidate };
}

/** Title and meta after the reviewer's field decisions. */
function resolveFields(
  execution: RefreshExecution,
  finalHtml: string,
): { title: string; metaDescription: string | null } {
  const { fields } = readDecisions(execution.decisions);
  const before = execution.before as ExecutionSide | null;
  const after = execution.after as ExecutionSide | null;
  // The H1 in the final body is the truest title: it reflects whichever hunk
  // the reviewer kept. Fields only decide the stored title when there is none.
  const h1 = finalHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]*>/g, "").trim();
  const title =
    h1 ||
    (fields.title === "accepted" ? after?.title : before?.title) ||
    before?.title ||
    after?.title ||
    "Untitled";
  const metaDescription =
    fields.metaDescription === "accepted"
      ? after?.metaDescription ?? before?.metaDescription ?? null
      : before?.metaDescription ?? null;
  return { title, metaDescription };
}

/** The reviewed body, ready to publish or copy. */
export function finalHtmlOf(execution: RefreshExecution): string {
  const { decisions, edited } = readDecisions(execution.decisions);
  return applyDecisions(execution.hunks as Hunk[], decisions, edited);
}

/**
 * What the reviewer would push, as HTML and Markdown, without pushing it.
 * The path for pages the product did not write and for sites with no CMS.
 */
export async function exportExecution(
  supabase: SupabaseClient,
  executionId: string,
): Promise<{ title: string; html: string; markdown: string; url: string }> {
  const { execution, candidate } = await loadExecution(supabase, executionId);
  const html = finalHtmlOf(execution);
  const { title } = resolveFields(execution, html);
  const { markdown } = htmlToMarkdown(`<main>${html}</main>`, candidate.url);
  return { title, html, markdown, url: candidate.url };
}

export interface PushResult {
  url: string;
  kept: number;
  total: number;
}

/**
 * Push the reviewed rewrite to the site.
 *
 * Preconditions, each its own error so the UI can say which one failed:
 *   - the execution is awaiting review (not already pushed or rejected)
 *   - at least one hunk was kept (pushing nothing is not a push)
 *   - the page is one we published, with an external id to update
 *   - the workspace's CMS adapter can update in place
 */
export async function pushExecution(
  supabase: SupabaseClient,
  executionId: string,
  opts: { destinationId?: string | null } = {},
): Promise<PushResult> {
  const { execution, candidate } = await loadExecution(supabase, executionId);
  if (execution.review_status !== "awaiting_review") {
    throw new Error(`This rewrite was already ${execution.review_status === "pushed" ? "pushed" : "rejected"}.`);
  }
  const { decisions, edited } = readDecisions(execution.decisions);
  const summary = summarizeDecisions(execution.hunks as Hunk[], decisions, edited);
  if (summary.kept === 0) {
    throw new Error("Nothing was kept. Keep at least one change before pushing, or reject the rewrite.");
  }
  if (!candidate.article_id) {
    throw new Error(
      "This page was not published through AltoRank, so there is no post to update. Copy the HTML or download the Markdown and apply it in your CMS.",
    );
  }

  const { data: article } = await supabase
    .from("articles")
    .select("id, workspace_id, slug, cms, external_id, published_url, featured_image_url")
    .eq("id", candidate.article_id)
    .eq("workspace_id", execution.workspace_id)
    .maybeSingle();
  if (!article) throw new Error("The article behind this page no longer exists");
  if (!article.external_id) {
    throw new Error(
      "This article has no CMS post id on record (it was published by hand), so it cannot be updated automatically. Copy the HTML instead.",
    );
  }

  const { data: wsIntegrations } = await supabase
    .from("workspace_integrations")
    .select("*, integration:integrations(*)")
    .eq("workspace_id", execution.workspace_id);
  const destination = chooseDestination(
    toDestinations((wsIntegrations ?? []) as IntegrationRow[]),
    article,
    opts.destinationId,
  );
  const row = (wsIntegrations ?? []).find((wi) => wi.id === destination.id)!;
  const config = decryptConfig(row.config as Record<string, unknown>) as CMSConfig;
  const adapter = resolveCMSAdapter(config);
  if (!canUpdate(adapter)) {
    throw new Error(
      `The ${destination.label} connection can publish new posts but cannot yet edit an existing one, and publishing a second copy of this page would be worse than not pushing. Copy the HTML and update the post in ${destination.label}.`,
    );
  }

  const html = finalHtmlOf(execution);
  const { title, metaDescription } = resolveFields(execution, html);

  const result = await adapter.update(article.external_id as string, {
    title,
    html,
    slug: article.slug as string,
    metaDescription: metaDescription ?? undefined,
    featuredImageUrl: (article.featured_image_url as string | null) ?? undefined,
  });

  const { data: ws } = await supabase
    .from("workspaces")
    .select("domain")
    .eq("id", execution.workspace_id)
    .single();
  const wordCount = html.replace(/<[^>]*>/g, " ").split(/\s+/).filter(Boolean).length;
  const publishedUrl = result.url || (article.published_url as string | null) || candidate.url;

  // The article row follows the site, so the next refresh diffs against what
  // is actually live and the editor shows the same body.
  const { error: articleErr } = await supabase
    .from("articles")
    .update({
      content: htmlToTiptapJson(html, { siteDomain: (ws?.domain as string | null) ?? null }),
      title,
      meta_description: metaDescription,
      word_count: wordCount,
      published_url: publishedUrl,
      updated_at: new Date().toISOString(),
    })
    .eq("id", article.id);
  if (articleErr) throw new Error(`Pushed, but could not record it on the article: ${articleErr.message}`);

  await supabase
    .from("refresh_executions")
    .update({
      review_status: "pushed",
      pushed_at: new Date().toISOString(),
      published_url: publishedUrl,
    })
    .eq("id", executionId);

  const { error: logErr } = await supabase.from("publish_log").insert({
    article_id: article.id,
    workspace_id: execution.workspace_id,
    status: "success",
    triggered_by: "manual",
  });
  if (logErr) console.error("publish_log insert failed:", logErr.message);

  return { url: publishedUrl, kept: summary.kept, total: summary.total };
}
