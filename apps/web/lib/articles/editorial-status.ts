/**
 * Statuses a plain edit may set on an article.
 *
 * Everything else moves through its own action: approveArticle records
 * approved_by, scheduleArticle checks the approval, and the publish flow is the
 * only thing that writes "live". `updateArticle` used to accept any string here,
 * which let a single call set status = "approved" with no approved_by and walk
 * straight through the approval gate in lib/publishing/core.ts.
 */
export const EDITORIAL_STATUSES = new Set(["draft", "review", "archived"]);

export function assertEditorialStatus(status: unknown): asserts status is string {
  if (typeof status !== "string" || !EDITORIAL_STATUSES.has(status)) {
    throw new Error(
      `Status "${String(status)}" cannot be set from the editor. Use the approve, schedule or publish actions.`,
    );
  }
}
