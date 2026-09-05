import { withAgent, appBaseUrl } from "@/lib/agent/http";
import { fail, ok } from "@/lib/agent/envelope";
import { articleInAgency, latestJob } from "@/lib/agent/data";
import { toAgentArticle } from "@/lib/agent/records";

/**
 * GET /api/agent/v1/articles/{id}
 *
 * The record plus its latest generation job, which is how an agent polls a
 * draft it asked for: status moves drafting -> review when the job completes.
 */
export const GET = withAgent<{ id: string }>(async (request, ctx, { id }) => {
  const article = await articleInAgency(ctx, id);
  if (!article) {
    return fail("not_found", "Article not found in this account.", "Call GET /articles?workspace_id= and use an id from that list.");
  }
  const [record, job] = [toAgentArticle(article, appBaseUrl(request)), await latestJob(ctx.supabase, article.workspace_id, article.id)];

  let guidance: string;
  switch (record.status) {
    case "drafting":
      guidance = "Still being written. Poll again in 30-60 seconds; a draft takes about two minutes.";
      break;
    case "review":
      guidance = `Ready for a human. Send them ${record.editor_url} to review, edit and approve. You cannot approve it.`;
      break;
    case "error":
      guidance = `Generation failed${job?.error ? `: ${job.error}` : ""}. You may regenerate (see allowed_mutations) after telling the human.`;
      break;
    case "live":
      guidance = "Published. Do not regenerate; a refresh is the human's call in the dashboard.";
      break;
    default:
      guidance = "Read allowed_mutations before acting on this article.";
  }

  return ok({ article: record, generation: job }, guidance, {
    _meta: {
      writeable_fields: [],
      hidden_from_human_summary_fields: ["article.id", "article.workspace_id", "article.slug", "generation.id"],
    },
  });
});
