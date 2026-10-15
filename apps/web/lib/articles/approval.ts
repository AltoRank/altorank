// ---------------------------------------------------------------------------
// What a person's change does to an article's approval
// ---------------------------------------------------------------------------
//
// An approval is a person signing off one specific text for publishing. The
// publish gate (lib/publishing/core.ts) trusts it: approved or scheduled, with
// `approved_by` set, ships. So whenever an article leaves the approved states
// by a person's hand, the approval goes with it, and the article is held so
// the workspace's auto-approve rule does not sign it off again unread in the
// same cron run. That is what requestChanges has always done; the other ways
// back to Review (Cancel on a schedule, Change status) now do the same.
//
// Pure, so the rules are testable without a database. Migration 109 holds the
// database to the same rules for a signed-in user's client.

/** The columns an approval lives in, all cleared together. */
export const APPROVAL_CLEARED = {
  approved_by: null,
  approved_at: null,
  approval_kind: null,
  scheduled_at: null,
} as const;

/** Statuses a plain edit may set; also the ones that never carry an approval. */
const EDITORIAL = new Set(["draft", "review", "archived"]);

/**
 * A person sent this back: Review, no approval, held from the auto-approve
 * rule until someone approves or releases it by hand.
 */
export function sentBackToReview(userId: string, now: string) {
  return {
    status: "review",
    ...APPROVAL_CLEARED,
    held_by: userId,
    held_at: now,
  } as const;
}

/**
 * The extra columns `updateArticle` writes when a person moves an article out
 * of an approved, scheduled, live or failed state into an editorial one, or
 * `null` when the change touches no approval.
 *
 * Moving to Review also holds it, for the reason requestChanges does: the rule
 * only looks at unheld drafts in Review, and a person who just pulled one back
 * did not mean "approve it again on the next run".
 */
export function approvalAfterStatusChange(
  row: { status: string },
  nextStatus: string | undefined,
  userId: string,
  now: string,
): Record<string, unknown> | null {
  if (nextStatus === undefined || nextStatus === row.status) return null;
  if (EDITORIAL.has(row.status)) return null;
  if (nextStatus === "review") return sentBackToReview(userId, now);
  return { status: nextStatus, ...APPROVAL_CLEARED };
}

/**
 * The columns of an article a reader sees. An approval is of these, as they
 * were when the person pressed Approve.
 */
export const APPROVED_TEXT_FIELDS = ["content", "title", "slug", "meta_description", "featured_image_url"] as const;

/** Approved or scheduled, or a failed publish still holding its approval for a retry. */
export function carriesApproval(row: { status: string; approved_by?: string | null }): boolean {
  return row.status === "approved" || row.status === "scheduled" || (row.status === "error" && row.approved_by != null);
}

/**
 * An edit saved after approval voids it: back to Review, held, for someone
 * to approve the text as it now reads. The editor used to save over an
 * approved or scheduled article and leave the approval in place, so the new
 * text shipped under the earlier approver's name, without the figure check
 * the approve action runs. `null` when the edit touches no approved text.
 */
export function approvalAfterTextEdit(
  row: { status: string; approved_by?: string | null },
  data: Record<string, unknown>,
  userId: string,
  now: string,
): Record<string, unknown> | null {
  if (!carriesApproval(row)) return null;
  if (!APPROVED_TEXT_FIELDS.some((f) => data[f] !== undefined)) return null;
  return sentBackToReview(userId, now);
}

