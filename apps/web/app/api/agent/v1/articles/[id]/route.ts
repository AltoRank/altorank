import { withAgent, appBaseUrl } from "@/lib/agent/http";
import { fail, ok } from "@/lib/agent/envelope";
import { articleInAgency, latestJob } from "@/lib/agent/data";
import { toAgentArticle } from "@/lib/agent/records";
import { getLastPublish } from "@/lib/publishing/log";

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
  const [job, last] = await Promise.all([
    latestJob(ctx.supabase, article.workspace_id, article.id),
    getLastPublish(ctx.supabase, article.workspace_id, article.id),
  ]);
  // The last publish attempt decides whether retry_publish is on offer; the
  // list endpoint leaves it unknown, this one looks.
  const record = toAgentArticle(article, appBaseUrl(request), { lastPublish: last ? last.status : null });

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
      guidance =
        record.allowed_mutations.retry_publish.allowed
          ? `The last publish failed${last?.error ? ` (${last.error})` : ""} and the article is approved. POST /articles/{id}/retry-publish re-runs it through the same connection; tell the human first.`
          : "Read allowed_mutations before acting on this article.";
  }

  return ok(
    {
      article: record,
      generation: job,
      last_publish: last ? { status: last.status, error: last.error, at: last.created_at, destination_id: last.destination_id } : null,
    },
    guidance,
    {
    _meta: {
      writeable_fields: [],
      hidden_from_human_summary_fields: ["article.id", "article.workspace_id", "article.slug", "generation.id", "last_publish.destination_id"],
    },
  });
});
