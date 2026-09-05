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

export type Mutation = { allowed: boolean; reason?: string };
export type AllowedMutations = Record<string, Mutation>;

const HUMAN_ONLY =
  "Approval and publishing are human actions in the dashboard. Hand the person the editor_url.";

const no = (reason: string): Mutation => ({ allowed: false, reason });
const yes: Mutation = { allowed: true };

export function articleMutations(article: { status: ArticleStatus }): AllowedMutations {
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

  return {
    regenerate,
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
  return {
    generate_draft,
    delete: no("Deleting is a human action in the dashboard."),
  };
}
