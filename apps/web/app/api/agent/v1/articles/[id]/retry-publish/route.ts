import { withAgent, appBaseUrl } from "@/lib/agent/http";
import { fail, ok } from "@/lib/agent/envelope";
import { articleInAgency } from "@/lib/agent/data";
import { articleMutations } from "@/lib/agent/mutations";
import { toAgentArticle } from "@/lib/agent/records";
import { needsPlanToShip, CHOOSE_PLAN_MESSAGE } from "@/lib/billing/quota";
import { getLastPublish } from "@/lib/publishing/log";
import { retryPublishCore } from "@/lib/publishing/retry";

// A CMS round trip, same budget the publish cron has.
export const maxDuration = 120;

/**
 * POST /api/agent/v1/articles/{id}/retry-publish
 *
 * Re-run the last FAILED publish of an article a human already approved. The
 * one path on this API that reaches a CMS, and it is narrow on purpose: it
 * only exists when a person approved the article, a publish was attempted
 * and that attempt failed. It is the editor's "Retry publish" button
 * (lib/publishing/retry.ts), not a publish call - there is none here, and
 * an article in review or draft is refused with what a human has to do.
 */
export const POST = withAgent<{ id: string }>(async (request, ctx, { id }) => {
  const article = await articleInAgency(ctx, id);
  if (!article) return fail("not_found", "Article not found in this account.", "Call GET /articles?workspace_id= and use an id from that list.");

  const last = await getLastPublish(ctx.supabase, article.workspace_id, article.id);
  const { retry_publish } = articleMutations(article, { lastPublish: last ? last.status : null });
  if (!retry_publish.allowed) {
    return fail(
      "not_available",
      retry_publish.reason ?? "Nothing to retry.",
      last?.status === "error"
        ? "A human must approve the article in the dashboard before it can go out again. Hand them editor_url; do not look for another way to publish."
        : "Retry only applies after a failed publish of an approved article. Do not try to publish it another way; publishing is a human action.",
    );
  }

  // Null caller: an API key is nobody's session. Same gate the button has.
  if (await needsPlanToShip(ctx.supabase, ctx.agencyId, null)) {
    return fail("quota_exceeded", CHOOSE_PLAN_MESSAGE, "Publishing needs a plan. Ask the human to choose one on the Billing page; do not retry until they have.");
  }

  const base = appBaseUrl(request);
  try {
    const result = await retryPublishCore(ctx.supabase, article.id, "manual");
    const after = await articleInAgency(ctx, article.id);
    return ok(
      {
        article_id: article.id,
        retried_of: last?.id ?? null,
        destination_id: result.destinationId,
        publish_mode: result.publishMode,
        published_url: result.url ?? after?.published_url ?? null,
        article: after ? toAgentArticle(after, base, { lastPublish: "success" }) : null,
      },
      `Published on retry via the same connection the failed attempt used. publish_log has the new row pointing at the failed one. ${
        result.url ? `Give the human the URL: ${result.url}.` : "Tell the human it went out."
      }`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(
      "upstream_error",
      `Retry failed: ${message}`,
      "The CMS refused again; the failure is logged. Report the message to the human verbatim and stop - do not retry in a loop, and do not try another connection.",
    );
  }
}, { scope: "write", mutation: true });
