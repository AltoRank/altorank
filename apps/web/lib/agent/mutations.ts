// ---------------------------------------------------------------------------
// allowed_mutations: what an agent may do to a record, and why not
// ---------------------------------------------------------------------------
//
// Every article and keyword the agent API returns carries this block, so the
// agent can read "can I regenerate this?" off the record instead of trying
// and parsing a refusal. Verbs that are never available through the agent
// surface (approve, publish, delete) are listed as false with the reason, so
// the absence is stated rather than left for the model to infer.
//
// Pure functions of the row. No Next imports.

import type { ArticleStatus, KeywordStatus } from "@/lib/types";
import { canRetryPublish } from "@/lib/publishing/log";

export type Mutation = { allowed: boolean; reason?: string };
export type AllowedMutations = Record<string, Mutation>;

const HUMAN_ONLY =
  "Approval and publishing are human actions in the dashboard. Hand the person the editor_url.";

const no = (reason: string): Mutation => ({ allowed: false, reason });
const yes: Mutation = { allowed: true };

export type ArticleMutationContext = {
  /**
   * The outcome of the article's most recent publish attempt, when the caller
   * looked it up. `undefined` means unknown (list endpoints do not fetch it);
   * `null` means it was never pushed.
   */
  lastPublish?: "success" | "error" | null;
};

export function articleMutations(article: { status: ArticleStatus }, context: ArticleMutationContext = {}): AllowedMutations {
  let regenerate: Mutation;
  switch (article.status) {
    case "live":
      regenerate = no("This article is published; create a refresh instead.");
      break;
    case "scheduled":
      regenerate = no("This article is scheduled to publish. Ask the human to unschedule it in the dashboard first.");
      break;
    case "approved":
      regenerate = no("This article was approved by a human. Regenerating would discard that approval; ask them first.");
      break;
    case "drafting":
      regenerate = no("Generation is already running for this article. Poll GET /articles/{id} until status changes.");
      break;
    case "archived":
      regenerate = no("This article is archived. Generate a new draft instead.");
      break;
    default:
      regenerate = yes;
  }

  // Find-and-replace edits the draft in place. Allowed while it is still the
  // agent's or the reviewer's to shape; refused once a human has signed it
  // off, because an edit after approval is an edit nobody approved.
  let replace: Mutation;
  switch (article.status) {
    case "draft":
    case "review":
    case "error":
      replace = yes;
      break;
    case "drafting":
      replace = no("Generation is running; the text is not settled yet. Poll GET /articles/{id} until status is review.");
      break;
    case "approved":
    case "scheduled":
      replace = no("This article was approved by a human. Editing it would void that approval; ask them to request changes in the dashboard first.");
      break;
    case "live":
      replace = no("This article is published. Changes to a live article go through the editor, where the human re-publishes.");
      break;
    default:
      replace = no("This article is archived.");
  }

  let retry_publish: Mutation;
  if (context.lastPublish === undefined) {
    retry_publish = no("Only offered when the last publish of an approved article failed; GET /articles/{id} says whether it did.");
  } else if (canRetryPublish(context.lastPublish === null ? null : { status: context.lastPublish }, article.status)) {
    retry_publish = yes;
  } else if (context.lastPublish !== "error") {
    retry_publish = no(context.lastPublish === null ? "This article has never been published." : "The last publish of this article succeeded.");
  } else {
    retry_publish = no(`The last publish failed but the article is ${article.status}, not approved. A human must approve it before it can be published again.`);
  }

  return {
    regenerate,
    replace,
    retry_publish,
    refresh:
      article.status === "live"
        ? no("Content refresh is not available through the agent API yet. Ask the human to use Refresh in the dashboard.")
        : no("Only a published article can be refreshed."),
    approve: no(HUMAN_ONLY),
    publish: no(HUMAN_ONLY),
    delete: no("Deleting is a human action in the dashboard."),
  };
}

export function keywordMutations(keyword: { status: KeywordStatus }): AllowedMutations {
  let generate_draft: Mutation;
  switch (keyword.status) {
    case "drafting":
      generate_draft = no("A draft is already being written for this keyword.");
      break;
    case "scheduled":
      generate_draft = no("An article for this keyword is scheduled to publish. Ask the human before writing another.");
      break;
    case "shipped":
      generate_draft = no("An article for this keyword is already live. Ask the human whether they want a second piece.");
      break;
    default:
      generate_draft = yes;
  }
  // On the plan and not yet written: the two calendar edits apply. The
  // planner's own rule - once an article exists, the article is the record.
  const onPlan = keyword.status === "planned";
  const notOnPlan = no(
    keyword.status === "new" || keyword.status === "stored"
      ? "This keyword is not on the content plan, so there is no planned day to move or remove."
      : "An article exists for this keyword; the article is managed from Articles, not the plan.",
  );
  return {
    generate_draft,
    reschedule: onPlan ? yes : notOnPlan,
    remove_from_plan: onPlan ? yes : notOnPlan,
    delete: no("Deleting is a human action in the dashboard."),
  };
}
