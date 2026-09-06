// ---------------------------------------------------------------------------
// Announcing what happened to an article, from wherever it happened
// ---------------------------------------------------------------------------
//
// The cron knows an article id and a workspace id; the email needs a domain, a
// title, an agency and a published URL. Rather than have each call site
// assemble that (and disagree about it), the call sites say what happened and
// this reads the rest.
//
// Only the unattended paths call these. When a person presses Publish they are
// watching the result on their screen, and the existing convention in
// lib/email/article-emails.ts is that an email about a thing on somebody's
// screen is noise, not news. The cron's failures and successes are the ones
// nobody sees.
//
// Nothing here throws. Every one of these runs after the work is done and
// recorded.

import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyArticlePublished, notifyPublishFailed } from "./lifecycle";
import { describeSendOutcome } from "./send-once";

type ArticleRow = {
  id: string;
  title: string | null;
  status: string | null;
  published_url: string | null;
  /** Where it went, written by the publisher. Names the CMS in the email. */
  cms: string | null;
  workspace_id: string;
  indexing_status: { urlVerified?: string } | null;
  workspaces: { domain: string | null; agency_id: string } | null;
};

const ARTICLE_COLUMNS =
  "id, title, status, published_url, cms, workspace_id, indexing_status, workspaces(domain, agency_id)";

async function loadArticle(supabase: SupabaseClient, articleId: string): Promise<ArticleRow | null> {
  const { data } = await supabase.from("articles").select(ARTICLE_COLUMNS).eq("id", articleId).maybeSingle();
  if (!data) return null;
  const row = data as unknown as Omit<ArticleRow, "workspaces"> & {
    workspaces: ArticleRow["workspaces"] | ArticleRow["workspaces"][];
  };
  // PostgREST returns an embedded to-one either as the object or as a
  // one-element array depending on how it inferred the relationship.
  const workspaces = Array.isArray(row.workspaces) ? (row.workspaces[0] ?? null) : row.workspaces;
  return { ...row, workspaces };
}

/**
 * "It is live, here is the link."
 *
 * Three states do not send, and each for the same reason - the email would
 * carry a claim we cannot back:
 *
 *   held as a draft on the CMS   `status` is still `approved`; it is on their
 *                                system but not on the web
 *   a git publish awaiting a     `urlVerified: "pending"`; the commit landed
 *   build                        but the URL is a prediction. cron/publish
 *                                Phase 3 calls this again once it resolves,
 *                                and the ledger makes that the only send
 *   the row could not be read    nothing to say
 */
export async function announceArticlePublished(supabase: SupabaseClient, articleId: string): Promise<string> {
  try {
    const article = await loadArticle(supabase, articleId);
    if (!article?.workspaces) return "";
    if (article.status !== "live") return "";
    if (article.indexing_status?.urlVerified === "pending") return "";

    const out = await notifyArticlePublished(
      supabase,
      { agencyId: article.workspaces.agency_id, workspaceId: article.workspace_id },
      {
        domain: article.workspaces.domain,
        title: article.title ?? "Your article",
        articleId: article.id,
        url: article.published_url,
      },
    );
    return describeSendOutcome(out);
  } catch (err) {
    return `email failed (${err instanceof Error ? err.message : "unknown"})`;
  }
}

/**
 * "It could not be published, here is what the CMS said."
 *
 * `attemptKey` is what makes a second failure a second email: the same article
 * failing again after somebody fixed the connection is news, while the same
 * cron run reporting the same failure twice is not. The publish_log row's id
 * or the failure's timestamp both work.
 */
export async function announcePublishFailed(
  supabase: SupabaseClient,
  opts: {
    articleId: string;
    workspaceId: string;
    reason: string;
    /** Overrides the article's own `cms` column, when the caller knows better. */
    destination?: string | null;
    committed?: boolean;
    attemptKey: string;
  },
): Promise<string> {
  try {
    const article = await loadArticle(supabase, opts.articleId);
    if (!article?.workspaces) return "";

    const out = await notifyPublishFailed(
      supabase,
      { agencyId: article.workspaces.agency_id, workspaceId: opts.workspaceId },
      {
        domain: article.workspaces.domain,
        title: article.title ?? "Your article",
        articleId: opts.articleId,
        reason: opts.reason,
        destination: opts.destination ?? article.cms,
        committed: opts.committed,
      },
      opts.attemptKey,
    );
    return describeSendOutcome(out);
  } catch (err) {
    return `email failed (${err instanceof Error ? err.message : "unknown"})`;
  }
}
