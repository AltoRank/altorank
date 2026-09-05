// ---------------------------------------------------------------------------
// Retrying a failed publish
// ---------------------------------------------------------------------------
//
// The old retryPublish reset the article to approved and called publish again.
// It did not check that anything had failed, so it was a second Publish button
// under another name; it did not know which connection the failed attempt had
// used; and a repeat of an attempt that had got as far as creating the post
// would have created another. The checks live here, on a plain SupabaseClient,
// so they are testable without the server-action wrapper.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getLastPublish, type LastPublish } from "./log";

export type RetryPlan = {
  workspaceId: string;
  /** The failed attempt being retried; its destination is reused, its id logged as retry_of. */
  last: LastPublish;
};

/**
 * Check that a retry makes sense and put the article in a state the publish
 * gate accepts. Throws, with the reason, when it does not.
 *
 * A cron failure leaves the article at 'error'; a manual failure leaves it
 * where it was. Both started from an approved article - nothing reaches the
 * adapter otherwise - so 'error' goes back to 'approved', with the recorded
 * approval intact. Anything the gate would refuse is refused here first, with
 * a message that says what to do instead.
 */
export async function prepareRetry(supabase: SupabaseClient, articleId: string): Promise<RetryPlan> {
  const { data: article } = await supabase
    .from("articles")
    .select("id, workspace_id, status, approved_by")
    .eq("id", articleId)
    .single();
  if (!article) throw new Error("Article not found");

  const last = await getLastPublish(supabase, article.workspace_id, articleId);
  if (!last) {
    throw new Error("Nothing to retry: this article has never been published.");
  }
  if (last.status !== "error") {
    throw new Error("Nothing to retry: the last publish of this article succeeded.");
  }

  if (article.status === "error") {
    if (!article.approved_by) {
      throw new Error("Approve the article before retrying: the failed attempt had no recorded approval.");
    }
    const { error } = await supabase
      .from("articles")
      .update({ status: "approved", updated_at: new Date().toISOString() })
      .eq("id", articleId)
      .eq("status", "error");
    if (error) throw new Error(error.message);
  } else if (article.status !== "approved" && article.status !== "scheduled") {
    throw new Error(
      `Approve the article before retrying (current status: ${article.status}).`,
    );
  }

  return { workspaceId: article.workspace_id, last };
}
