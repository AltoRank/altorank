import { withAgent, readJson, appBaseUrl } from "@/lib/agent/http";
import { fail, ok } from "@/lib/agent/envelope";
import { articleInAgency } from "@/lib/agent/data";
import { articleMutations } from "@/lib/agent/mutations";
import { applyReplace, replaceBodySchema, type ReplaceBody } from "@/lib/agent/replace";

const bodySchema = replaceBodySchema;

/**
 * POST /api/agent/v1/articles/{id}/replace
 *
 * Find-and-replace inside one draft. `preview_only` defaults to TRUE: the
 * response is a proposal - every hit with the sentence around it - and the
 * article is untouched. Send `preview_only: false` to write the same change.
 * Either way the article's status does not move: this edits a draft, it
 * never approves, schedules or publishes one. There is no call that does.
 */
export const POST = withAgent<{ id: string }>(async (request, ctx, { id }) => {
  const parsed = await readJson<unknown>(request);
  if ("envelope" in parsed) return parsed.envelope;
  const body = bodySchema.safeParse(parsed.body);
  if (!body.success) {
    return fail(
      "invalid_request",
      body.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      "Send { find, replace, match_case?, whole_word?, preview_only? (default true) }.",
    );
  }

  const article = await articleInAgency(ctx, id);
  if (!article) return fail("not_found", "Article not found in this account.", "Call GET /articles?workspace_id= and use an id from that list.");
  const { replace } = articleMutations(article);
  if (!replace.allowed) {
    return fail("not_available", replace.reason ?? "This article cannot be edited.", "Tell the human why; do not retry. allowed_mutations on the record says what is possible.");
  }

  const result = await applyReplace(ctx.supabase, article, body.data as ReplaceBody, appBaseUrl(request));
  return ok(result.data, result.guidance, { _human: result.human, _meta: { writeable_fields: ["title", "content"], hidden_from_human_summary_fields: ["article_id", "workspace_id"] } });
}, { scope: "write", mutation: true });
