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
import { htmlToTiptapJson } from "@/lib/ai/tiptap";
import { factCheckArticle, approvalBlocker } from "@/lib/ai/fact-check";
import { htmlToMarkdown } from "@/lib/audit/markdown";
import { decodeEntities } from "@/lib/audit/html-utils";
import { tiptapToHtml } from "@/lib/cms/html";
import { readVisibleArticle } from "@/lib/articles/body-read";
import { needsPlanToShip, CHOOSE_PLAN_MESSAGE } from "@/lib/billing/quota";
import { workspaceTrialGate } from "@/lib/billing/body-lock";
import { BODY_LOCKED_MESSAGE } from "@/lib/billing/trial-refusal";
import { deliverArticle, PublishError, type DeliverableArticle } from "@/lib/publishing/core";
import { recordPublish } from "@/lib/publishing/log";
import { readWorkspaceLanguage } from "@/lib/i18n/workspace-language";
import { createServiceClient } from "@/lib/supabase/server";
import type { ArticleResearch } from "@/lib/seo/research";
import { applyDecisions, readDecisions, summarizeDecisions } from "./hunks";
import type { ExecutionSide, Hunk, RefreshCandidate, RefreshExecution } from "./types";

/**
 * Adapter types that implement `update`, for the UI.
 *
 * Re-exported rather than restated. This was a literal of five while eleven
 * adapters could update, so the refresh screens hid "Push to site" from six
 * CMSs whose push would have worked - see UPDATABLE_CMS_TYPES in
 * lib/cms/adapter.ts, which derives it from the adapters themselves.
 */
export { UPDATABLE_CMS_TYPES as UPDATABLE_CMS } from "@/lib/cms/adapter";

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
  const { markdown } = htmlToMarkdown(`<main>${html}</main>`, candidate.url, { images: "linked" });
  return { title, html, markdown, url: candidate.url };
}

export interface PushResult {
  url: string;
  kept: number;
  total: number;
}

/** Who pressed Push: the person the push is recorded under. */
export interface Pusher {
  id: string;
  email?: string | null;
}

/**
 * What a body says, for telling whether a page changed: its text and the
 * addresses it links and shows, without markup. Whitespace, attribute order
 * and entity spelling differ between renderer versions and do not count.
 */
function bodyFingerprint(html: string): string {
  const body = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ");
  const addresses = [...body.matchAll(/<(?:a|img|iframe)\b[^>]*?\s(?:href|src)\s*=\s*["']([^"']*)["']/gi)].map((m) =>
    decodeEntities(m[1]).trim(),
  );
  const text = decodeEntities(body.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  return JSON.stringify([text, addresses]);
}

/**
 * Whether the article changed after the rewrite read it.
 *
 * The push sends the whole post: the blocks nobody kept are the text the
 * rewrite read. When the article has changed since (an edit saved in the
 * editor, or another rewrite of the same page pushed first), sending them
 * would quietly put the old text back. The article row is the copy of the
 * live post every publish and push writes, so it is what is compared.
 */
export function pageChangedSinceRewrite(
  before: Pick<ExecutionSide, "html"> | null | undefined,
  currentHtml: string,
): boolean {
  if (!before?.html) return true;
  return bodyFingerprint(before.html) !== bodyFingerprint(currentHtml);
}

export const PAGE_CHANGED_MESSAGE =
  "This page has changed since the rewrite was written (an edit in the editor, or another improvement pushed first). Pushing it now would put the old text of every block you did not keep back on the site. Reject this rewrite and schedule a new one from the current page.";

type PushArticle = DeliverableArticle & { id: string; status?: string | null; research?: unknown };

/** The plan and trial gates a publish has, asked of the account that owns the site. */
async function refuseWithoutPlan(supabase: SupabaseClient, workspaceId: string, pusher: Pusher): Promise<void> {
  const { data: site, error } = await supabase.from("workspaces").select("account_id").eq("id", workspaceId).maybeSingle();
  if (error) throw new Error(`Could not read the site: ${error.message}`);
  if (!site?.account_id) throw new Error("The site behind this rewrite no longer exists");
  if (await needsPlanToShip(supabase, site.account_id as string, pusher.email)) throw new Error(CHOOSE_PLAN_MESSAGE);
  if ((await workspaceTrialGate(supabase, workspaceId)) === "gated") throw new Error(BODY_LOCKED_MESSAGE);
}

/**
 * Push the reviewed rewrite to the site.
 *
 * The same gates and the same renderer as a publish, because a push is one:
 *   - the execution is awaiting review, at least one hunk was kept, and the
 *     page is one we published, with a post id to update in place
 *   - the site's account has a plan (and its trial gate is open)
 *   - the article has not changed since the rewrite read it
 *   - the fact check passes on the body that goes out, as at Approve
 *   - the body is rebuilt as the editor's document and published through
 *     `deliverArticle`, so it gets the dateline, structured data, webhook
 *     Markdown and the connection's publish mode a publish gets
 *   - the pusher is recorded as the approval of the new text, on the article
 *     and on the execution, written by the server
 */
export async function pushExecution(
  supabase: SupabaseClient,
  executionId: string,
  opts: { destinationId?: string | null; pusher: Pusher },
): Promise<PushResult> {
  const { pusher } = opts;
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

  // Which row through the caller's client (RLS), its text from the server
  // (migration 097).
  const article = await readVisibleArticle<PushArticle>(supabase, candidate.article_id);
  if (!article || article.workspace_id !== execution.workspace_id) {
    throw new Error("The article behind this page no longer exists");
  }
  if (!article.external_id) {
    throw new Error(
      "This article has no CMS post id on record (it was published by hand), so it cannot be updated automatically. Copy the HTML instead.",
    );
  }

  await refuseWithoutPlan(supabase, execution.workspace_id, pusher);

  const current = article.content ? tiptapToHtml(article.content as Record<string, unknown>) : "";
  if (pageChangedSinceRewrite(execution.before, current)) throw new Error(PAGE_CHANGED_MESSAGE);

  const { data: ws } = await supabase
    .from("workspaces")
    .select("domain")
    .eq("id", execution.workspace_id)
    .single();

  // The reviewed body as the editor's document: what the article row will
  // hold, and what the publish renderer reads. Rebuilding it drops anything
  // the editor does not keep, the same as an imported draft.
  const content = htmlToTiptapJson(finalHtmlOf(execution), { siteDomain: (ws?.domain as string | null) ?? null });
  const body = tiptapToHtml(content as unknown as Record<string, unknown>);
  const { title, metaDescription } = resolveFields(execution, body);

  // The approve action's figure check, on the body that goes out. The
  // rewrite's own report covered the whole rewrite, not what was kept.
  const language = await readWorkspaceLanguage(supabase, execution.workspace_id, "push");
  const report = factCheckArticle(body, (article.research as ArticleResearch | null) ?? undefined, language);
  const blocker = approvalBlocker(report);
  if (blocker) throw new Error(blocker.replace(/then approve\.$/, "then push."));

  // A push edits a page that is on the site. On a draft-mode connection the
  // adapters read "draft" as "unpublish" (WordPress, Ghost, Shopify, Webflow
  // and others set the post back to draft), so the connection's mode would
  // take a live, ranking page off the site to apply an edit to it. A live
  // post stays live; a post still held as a draft in the CMS stays held.
  const liveOnSite = article.status === "live" || Boolean(article.found_on_site_at);

  let delivered;
  try {
    delivered = await deliverArticle(
      supabase,
      { ...article, title, meta_description: metaDescription, content },
      article.id,
      { destinationId: opts.destinationId, inPlaceOnly: true, ...(liveOnSite ? { publishMode: "publish" as const } : {}) },
    );
  } catch (err) {
    const context = err instanceof PublishError ? err.context : null;
    await recordPublish(supabase, {
      articleId: article.id,
      workspaceId: execution.workspace_id,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      triggeredBy: "manual",
      destinationId: context?.destinationId,
      publishMode: context?.publishMode,
    });
    throw err;
  }

  const now = new Date().toISOString();
  const wordCount = body.replace(/<[^>]*>/g, " ").split(/\s+/).filter(Boolean).length;
  const publishedUrl = delivered.url || (article.published_url as string | null) || candidate.url;

  // The article row follows the site, so the next refresh diffs against what
  // is actually live and the editor shows the same body. The push is the
  // sign-off on this text, so it is recorded where approvals are: by the
  // server, under the person who pressed it (migration 109).
  const admin = createServiceClient();
  const { error: articleErr } = await admin
    .from("articles")
    .update({
      content,
      title,
      meta_description: metaDescription,
      word_count: wordCount,
      // An update that reports no address (a webhook endpoint that answers
      // without one) still leaves the page where it was: keep its URL rather
      // than the null the publish bookkeeping writes for "no address yet".
      ...(liveOnSite ? { published_url: publishedUrl } : {}),
      fact_checks: report,
      fact_check_verdict: report.verdict,
      approved_by: pusher.id,
      approved_at: now,
      approval_kind: "human",
      updated_at: now,
    })
    .eq("id", article.id);
  if (articleErr) throw new Error(`Pushed, but could not record it on the article: ${articleErr.message}`);

  const { error: execErr } = await admin
    .from("refresh_executions")
    .update({ review_status: "pushed", pushed_at: now, published_url: publishedUrl })
    .eq("id", executionId);
  if (execErr) console.error("refresh_executions push record failed:", execErr.message);
  // Who pushed, on the execution itself (migration 113). Its own write, so a
  // database without the column still records the push above.
  const { error: byErr } = await admin.from("refresh_executions").update({ pushed_by: pusher.id }).eq("id", executionId);
  if (byErr) console.warn("refresh_executions.pushed_by not recorded:", byErr.message);

  await recordPublish(supabase, {
    articleId: article.id,
    workspaceId: execution.workspace_id,
    status: "success",
    triggeredBy: "manual",
    destinationId: delivered.destinationId,
    publishMode: delivered.publishMode,
  });

  return { url: publishedUrl, kept: summary.kept, total: summary.total };
}
