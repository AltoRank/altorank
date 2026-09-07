"use server";

import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { needsPlanToShip, CHOOSE_PLAN_MESSAGE } from "@/lib/billing/quota";
import { approveArticle } from "@/app/actions/publish";

/**
 * Finish the thing the payment was for.
 *
 * Someone on a review draft with no plan is not shopping for a subscription;
 * they are trying to approve an article. Before this, the paywall sent them to
 * Billing and forgot why: they paid, landed on an invoice table, and had to
 * find their way back to a draft that was still sitting in review. The
 * purchase completed and the job did not.
 *
 * So the paywall CTA carries `?intent=approve` through checkout's return URL,
 * and the editor hands it here on arrival.
 *
 * The query string is a *hint*, never an authorisation. This re-runs
 * `approveArticle`, which re-checks the plan, re-runs the fact check on what
 * is in the editor now, and refuses anything not in review - exactly as if the
 * button had been pressed. A crafted `?intent=approve` therefore does nothing
 * a person could not do by clicking Approve themselves.
 */
export type ApprovalIntentResult =
  /** Approved, for real, just now. */
  | { status: "approved" }
  /**
   * Paid, but Stripe's webhook has not landed yet, so the account still reads
   * as no-plan. This is the ordinary case for the first second or two after
   * checkout - the redirect races `checkout.session.completed` - and the only
   * correct answer is to wait and ask again, never to approve on the strength
   * of the URL.
   */
  | { status: "confirming" }
  /** The fact-check gate (or another rule) refused. Its reason, verbatim. */
  | { status: "blocked"; reason: string }
  /** Nothing to do: the draft moved on while the buyer was at Stripe. */
  | { status: "moved"; reason: string }
  | { status: "error"; reason: string };

/** Statuses that mean the approval already happened, one way or another. */
const PAST_REVIEW = new Set(["approved", "scheduled", "live"]);

export async function completeApprovalIntent(articleId: string): Promise<ApprovalIntentResult> {
  const { user, agencyId } = await requireAuth();
  const supabase = await createClient();

  // Asked before the article is even read, because "your plan is not visible
  // yet" is a different sentence from any of the article ones and the person
  // is watching a spinner while we decide which to show.
  if (await needsPlanToShip(supabase, agencyId, user.email)) return { status: "confirming" };

  const { data: article, error } = await supabase
    .from("articles")
    .select("status")
    .eq("id", articleId)
    .maybeSingle();

  if (error) return { status: "error", reason: error.message };
  if (!article) return { status: "error", reason: "That draft is no longer here." };

  if (PAST_REVIEW.has(article.status as string)) {
    return {
      status: "moved",
      reason:
        article.status === "approved"
          ? "This draft was already approved — it is ready to publish."
          : `This draft is already ${article.status}.`,
    };
  }
  if (article.status !== "review") {
    return {
      status: "moved",
      reason: `This draft is back in ${article.status}, so there is nothing to approve yet. Send it to review and approve it from there.`,
    };
  }

  try {
    await approveArticle(articleId);
    return { status: "approved" };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // The plan lapsed between the two checks, or the webhook wrote something
    // other than active. Same answer as above: wait, do not approve.
    if (reason === CHOOSE_PLAN_MESSAGE) return { status: "confirming" };
    return { status: "blocked", reason };
  }
}
