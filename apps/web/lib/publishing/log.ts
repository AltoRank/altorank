// ---------------------------------------------------------------------------
// publish_log: the audit trail, and the one place that writes it
// ---------------------------------------------------------------------------
//
// Three call sites used to insert their own rows with slightly different
// shapes, and none of them recorded which connection the attempt went through.
// That was fine while the log was only ever read as a list. It stops being
// fine the moment a failed row has to be retried: a retry must go back through
// the same connection, and a workspace with two CMSs could not tell which.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PublishMode } from "@/lib/cms/types";

export type PublishLogWrite = {
  articleId: string;
  workspaceId: string;
  status: "success" | "error";
  error?: string | null;
  triggeredBy: "cron" | "manual";
  /** The workspace_integrations row the attempt used, once one was chosen. */
  destinationId?: string | null;
  publishMode?: PublishMode | null;
  /** The failed row this attempt is a retry of. */
  retryOf?: string | null;
};

/**
 * Append one row. Never throws: a publish that already happened is not undone
 * by a logging failure, but the failure is not swallowed either.
 */
export async function recordPublish(supabase: SupabaseClient, entry: PublishLogWrite): Promise<void> {
  const { error } = await supabase.from("publish_log").insert({
    article_id: entry.articleId,
    workspace_id: entry.workspaceId,
    status: entry.status,
    error: entry.error ?? null,
    triggered_by: entry.triggeredBy,
    destination_id: entry.destinationId ?? null,
    publish_mode: entry.publishMode ?? null,
    retry_of: entry.retryOf ?? null,
  });
  if (error) console.error("publish_log insert failed:", error.message);
}

/** The columns a retry, a button or a pill needs from the most recent attempt. */
export type LastPublish = {
  id: string;
  status: "success" | "error";
  error: string | null;
  destination_id: string | null;
  publish_mode: PublishMode | null;
  created_at: string;
};

const LAST_PUBLISH_COLUMNS = "id, article_id, status, error, destination_id, publish_mode, created_at";

/** The most recent attempt for one article, or null if it was never pushed. */
export async function getLastPublish(
  supabase: SupabaseClient,
  workspaceId: string,
  articleId: string,
): Promise<LastPublish | null> {
  const { data } = await supabase
    .from("publish_log")
    .select(LAST_PUBLISH_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("article_id", articleId)
    .order("created_at", { ascending: false })
    .limit(1);
  return (data?.[0] as LastPublish | undefined) ?? null;
}

/**
 * The most recent attempt for each of several articles, keyed by article id.
 * For lists: one query, then the newest row per article wins.
 */
export async function getLastPublishes(
  supabase: SupabaseClient,
  workspaceIds: string[],
  articleIds: string[],
): Promise<Map<string, LastPublish>> {
  const out = new Map<string, LastPublish>();
  if (workspaceIds.length === 0 || articleIds.length === 0) return out;
  const { data } = await supabase
    .from("publish_log")
    .select(LAST_PUBLISH_COLUMNS)
    .in("workspace_id", workspaceIds)
    .in("article_id", articleIds)
    .order("created_at", { ascending: false });
  for (const row of (data ?? []) as (LastPublish & { article_id: string })[]) {
    if (!out.has(row.article_id)) out.set(row.article_id, row);
  }
  return out;
}

/**
 * Whether "Retry publish" applies: the last attempt failed and the article is
 * in a state a publish can start from. A draft or a review-state article with
 * an old failure behind it is not retryable - it has to be approved again,
 * which is a different button.
 */
export function canRetryPublish(
  last: Pick<LastPublish, "status"> | null | undefined,
  articleStatus: string,
): boolean {
  if (last?.status !== "error") return false;
  return articleStatus === "approved" || articleStatus === "error" || articleStatus === "scheduled";
}
