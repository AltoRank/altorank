import { after } from "next/server";
import { z } from "zod";
import { withAgent, readJson, appBaseUrl } from "@/lib/agent/http";
import { fail, ok } from "@/lib/agent/envelope";
import { articleInAgency, workspaceInAgency } from "@/lib/agent/data";
import { articleMutations } from "@/lib/agent/mutations";
import { toAgentArticle } from "@/lib/agent/records";
import { generateArticle, slugFor } from "@/lib/content/generate";
import { getQuota, quotaExceededMessage } from "@/lib/billing/quota";
import type { Article } from "@/lib/types";

// The model call is the long pole; same budget the generate cron has.
export const maxDuration = 300;

const bodySchema = z.object({
  workspace_id: z.uuid(),
  keyword: z.string().trim().min(2).max(200),
  title: z.string().trim().min(2).max(200).optional(),
  /** Regenerate into an existing draft instead of creating a new row. */
  article_id: z.uuid().optional(),
  /**
   * Past the plan's included volume the next draft bills as overage. False by
   * default: an agent must not spend a customer's money without being told.
   */
  allow_overage: z.boolean().default(false),
});

/**
 * POST /api/agent/v1/articles/generate
 *
 * Creates the row, answers 202 with its id, and writes the draft after the
 * response. The result always lands in `review`; there is no flag that makes
 * it land anywhere else. Poll GET /articles/{id} for progress, then hand the
 * human the editor_url.
 *
 * Generation runs in `after()`, so it is bounded by this route's maxDuration.
 * If the function is cut off mid-run the row stays in `drafting`, the same
 * failure mode the cron documents; GET /articles/{id} shows it.
 */
export const POST = withAgent(async (request, ctx) => {
  const parsed = await readJson<unknown>(request);
  if ("envelope" in parsed) return parsed.envelope;
  const body = bodySchema.safeParse(parsed.body);
  if (!body.success) {
    return fail(
      "invalid_request",
      body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      "Send { workspace_id, keyword, title?, article_id?, allow_overage? }.",
    );
  }
  const { workspace_id, keyword, title, article_id, allow_overage } = body.data;

  const workspace = await workspaceInAgency(ctx, workspace_id);
  if (!workspace) {
    return fail("not_found", "Workspace not found in this account.", "Call GET /workspaces and use an id from that list.");
  }

  // Regenerating: the target must be in this workspace and in a state that
  // allows it. The same rule the record advertises, enforced.
  if (article_id) {
    const existing = await articleInAgency(ctx, article_id);
    if (!existing || existing.workspace_id !== workspace.id) {
      return fail("not_found", "Article not found in this workspace.", "Use an id from GET /articles?workspace_id= for the same workspace.");
    }
    const { regenerate } = articleMutations(existing);
    if (!regenerate.allowed) {
      return fail("not_available", regenerate.reason ?? "This article cannot be regenerated.", "Tell the human why; do not retry. allowed_mutations on the record says what is possible.");
    }
  }

  // Spend gate, before any row is written. Null caller: a key is nobody's
  // session, the same contract the cron uses.
  const quota = await getQuota(ctx.supabase, ctx.agencyId, null);
  if (quota.limit !== null && (quota.remaining ?? 0) <= 0) {
    if (quota.reason === "no-plan") {
      return fail("quota_exceeded", quotaExceededMessage(quota), "The free draft is used and there is no plan. Ask the human to choose one on the Billing page; do not retry until they have.");
    }
    if (!allow_overage) {
      return fail(
        "quota_exceeded",
        `This month's included ${quota.limit} articles are used. The next draft bills as overage.`,
        "Ask the human whether to pay overage for this draft. Only if they say yes, retry with allow_overage: true.",
      );
    }
  }

  let articleRowId = article_id;
  if (!articleRowId) {
    const { data: created, error } = await ctx.supabase
      .from("articles")
      .insert({
        workspace_id: workspace.id,
        title: title || keyword,
        slug: slugFor(title || keyword),
        keyword,
        status: "drafting",
        ai_provider: workspace.ai_provider || "claude",
        generated_autonomously: false,
      })
      .select("*")
      .single();
    if (error || !created) throw new Error(error?.message ?? "Could not create the article row");
    articleRowId = (created as Article).id;
  }
  const targetId = articleRowId;

  after(async () => {
    try {
      await generateArticle({
        supabase: ctx.supabase,
        workspaceId: workspace.id,
        keyword,
        title,
        articleId: targetId,
        callerEmail: null,
      });
    } catch (err) {
      // generateArticle restores the status it found, which for a row this
      // route just created is `drafting`. That would read as "still running"
      // forever, so say what actually happened.
      console.error("[agent api] generate failed:", err instanceof Error ? err.message : err);
      await ctx.supabase
        .from("articles")
        .update({ status: "error", updated_at: new Date().toISOString() })
        .eq("id", targetId)
        .eq("workspace_id", workspace.id);
    }
  });

  const row = await articleInAgency(ctx, targetId);
  const record = row ? toAgentArticle({ ...row, status: "drafting" }, appBaseUrl(request)) : null;

  return {
    status: 202,
    envelope: ok(
      {
        article_id: targetId,
        status: "drafting",
        editor_url: record?.editor_url ?? `${appBaseUrl(request)}/content/${targetId}`,
        poll_url: `${appBaseUrl(request)}/api/agent/v1/articles/${targetId}`,
        article: record,
        overage: quota.limit !== null && (quota.remaining ?? 0) <= 0,
      },
      "Draft started; it takes about two minutes. Poll poll_url every 30-60s until status is review, then send the human editor_url. It will not publish itself and you cannot publish it.",
    ),
  };
}, { scope: "generate" });
