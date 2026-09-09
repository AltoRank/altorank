import { after } from "next/server";
import { z } from "zod";
import { withAgent, readJson, appBaseUrl } from "@/lib/agent/http";
import { fail, ok } from "@/lib/agent/envelope";
import { articleInAccount, workspaceInAccount } from "@/lib/agent/data";
import { bindIdempotencyKey, claimIdempotencyKey, idempotencyKeyFrom, releaseIdempotencyKey } from "@/lib/agent/idempotency";
import { articleMutations } from "@/lib/agent/mutations";
import { toAgentArticle } from "@/lib/agent/records";
import { generateArticle, slugFor } from "@/lib/content/generate";
import { freeAllowanceUsedMessage, getQuota, quotaExceededMessage } from "@/lib/billing/quota";
import { accountPausedMessage } from "@/lib/billing/pause";
import type { Article } from "@/lib/types";

// The model call is the long pole; same budget the generate cron has.
export const maxDuration = 300;

const bodySchema = z.object({
  workspace_id: z.uuid(),
  keyword: z.string().trim().min(2).max(200),
  /**
   * The keyword row the draft is briefed from, when the agent has one (from
   * GET /keywords). Without it the brief is looked up by term with an
   * ilike match, which finds the wrong row when two terms differ only in
   * case or a plural, and finds nothing for a term typed fresh.
   */
  keyword_id: z.uuid().optional(),
  title: z.string().trim().min(2).max(200).optional(),
  /** Regenerate into an existing draft instead of creating a new row. */
  article_id: z.uuid().optional(),
  /**
   * Past the plan's included volume the next draft bills as overage. False by
   * default: an agent must not spend a customer's money without being told.
   */
  allow_overage: z.boolean().default(false),
  /**
   * Same as the Idempotency-Key header. A repeat with the same key within
   * 24 hours returns the draft the first call started; no second row, no
   * second quota unit. Send one on every call, and reuse it after a timeout.
   */
  idempotency_key: z.string().optional(),
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
 *
 * A timed-out request looks, to the caller, like one that never happened.
 * `Idempotency-Key` (or `idempotency_key` in the body) makes the retry safe:
 * the key is claimed before any row is written, bound to the row, and a
 * repeat within 24h gets that row back with `replayed: true`.
 */
export const POST = withAgent(async (request, ctx) => {
  const parsed = await readJson<unknown>(request);
  if ("envelope" in parsed) return parsed.envelope;
  const body = bodySchema.safeParse(parsed.body);
  if (!body.success) {
    return fail(
      "invalid_request",
      body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      "Send { workspace_id, keyword, keyword_id?, title?, article_id?, allow_overage? }.",
    );
  }
  const { workspace_id, keyword, keyword_id, title, article_id, allow_overage } = body.data;
  const keyRead = idempotencyKeyFrom(request, parsed.body);
  if (!keyRead.ok) {
    return fail("invalid_request", keyRead.message, "Send an Idempotency-Key of up to 200 printable characters, e.g. a UUID you generate per intended draft.");
  }
  const idemKey = keyRead.key;

  const workspace = await workspaceInAccount(ctx, workspace_id);
  if (!workspace) {
    return fail("not_found", "Workspace not found in this account.", "Call GET /workspaces and use an id from that list.");
  }

  // The account pause, ahead of the row and the `after()` that would write it.
  // generateArticle refuses this too, but it runs after the response has been
  // sent, so without this check the agent gets 200 and "drafting" for a draft
  // that can never exist and only learns otherwise by polling a row into
  // `error`. Same reason the spend gate below runs here rather than there.
  if (workspace.paused_until && workspace.status === "paused") {
    return fail(
      "not_available",
      accountPausedMessage(workspace.paused_until),
      "The whole account is paused, so no workspace can be written to and nothing is being billed. Ask the human to resume it on the Billing page; do not retry until they have.",
    );
  }

  // A keyword id names a row in *this* workspace or it names nothing: a
  // keyword from another site would brief the draft with the wrong
  // instructions and, on insert, point articles.keyword_id across tenants.
  if (keyword_id) {
    const { data: kw } = await ctx.supabase
      .from("keywords")
      .select("id")
      .eq("id", keyword_id)
      .eq("workspace_id", workspace.id)
      .maybeSingle();
    if (!kw) {
      return fail("not_found", "keyword_id is not a keyword of this workspace.", "Use an id from GET /keywords?workspace_id= for the same workspace, or omit keyword_id.");
    }
  }

  // Regenerating: the target must be in this workspace and in a state that
  // allows it. The same rule the record advertises, enforced.
  if (article_id) {
    const existing = await articleInAccount(ctx, article_id);
    if (!existing || existing.workspace_id !== workspace.id) {
      return fail("not_found", "Article not found in this workspace.", "Use an id from GET /articles?workspace_id= for the same workspace.");
    }
    const { regenerate } = articleMutations(existing);
    if (!regenerate.allowed) {
      return fail("not_available", regenerate.reason ?? "This article cannot be regenerated.", "Tell the human why; do not retry. allowed_mutations on the record says what is possible.");
    }
  }

  // The key is claimed before the spend gate and before any row, so a
  // duplicate that arrives while this one is still inside the gate cannot
  // pass it a second time. A refusal below releases the claim: the human's
  // "yes" to overage should make the same key work, not replay a refusal.
  if (idemKey) {
    const claim = await claimIdempotencyKey(ctx.supabase, ctx.accountId, idemKey);
    if (claim.state === "replay") {
      const existing = claim.article_id ? await articleInAccount(ctx, claim.article_id) : null;
      if (claim.article_id && !existing) {
        // Bound to an article that is gone: nothing to replay, start over.
        await releaseIdempotencyKey(ctx.supabase, ctx.accountId, idemKey);
        const again = await claimIdempotencyKey(ctx.supabase, ctx.accountId, idemKey);
        if (again.state === "replay") return inFlight();
      } else if (!existing) {
        return inFlight();
      } else {
        const record = toAgentArticle(existing, appBaseUrl(request));
        return {
          status: 200,
          envelope: ok(
            {
              article_id: existing.id,
              status: existing.status,
              editor_url: record.editor_url,
              poll_url: `${appBaseUrl(request)}/api/agent/v1/articles/${existing.id}`,
              article: record,
              overage: false,
              replayed: true,
            },
            `This Idempotency-Key was already used at ${new Date(claim.created_at).toISOString()}: this is the draft that call started, not a new one, and nothing more was billed. Poll poll_url until status is review; if status is error, start a new draft with a NEW key.`,
          ),
        };
      }
    }
  }
  const release = async () => {
    if (idemKey) await releaseIdempotencyKey(ctx.supabase, ctx.accountId, idemKey);
  };

  // Spend gate, before any row is written. Null caller: a key is nobody's
  // session, the same contract the cron uses.
  const quota = await getQuota(ctx.supabase, ctx.accountId, null);
  if (quota.limit !== null && (quota.remaining ?? 0) <= 0) {
    if (quota.reason === "no-plan") {
      await release();
      return fail(
        "quota_exceeded",
        quotaExceededMessage(quota),
        `${freeAllowanceUsedMessage(quota.limit ?? undefined)} They are a one-time allowance and do not reset. There is no plan. Ask the human to choose one on the Billing page; do not retry until they have.`,
      );
    }
    if (!allow_overage) {
      await release();
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
        keyword_id: keyword_id ?? null,
        status: "drafting",
        ai_provider: workspace.ai_provider || "claude",
        generated_autonomously: false,
      })
      .select("*")
      .single();
    if (error || !created) {
      await release();
      throw new Error(error?.message ?? "Could not create the article row");
    }
    articleRowId = (created as Article).id;
  }
  const targetId = articleRowId;
  if (idemKey) await bindIdempotencyKey(ctx.supabase, ctx.accountId, idemKey, targetId);

  after(async () => {
    try {
      await generateArticle({
        supabase: ctx.supabase,
        workspaceId: workspace.id,
        keyword,
        keywordId: keyword_id,
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

  const row = await articleInAccount(ctx, targetId);
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
        replayed: false,
      },
      `Draft started; it takes about two minutes. Poll poll_url every 30-60s until status is review, then send the human editor_url. It will not publish itself and you cannot publish it.${idemKey ? "" : " Next time send an Idempotency-Key: if this call had timed out you would have had no safe way to retry it."}`,
    ),
  };
// `mutation: true`: this route writes a row and starts a model call, and it
// sat outside the per-key mutation limiter that every other write has, so a
// looping agent could open drafts as fast as the read limit allowed.
}, { scope: "generate", mutation: true });

/** A duplicate arrived in the one-statement window between claim and row. */
function inFlight() {
  return fail(
    "not_available",
    "A request with this Idempotency-Key is still being set up.",
    "Wait a few seconds and repeat the same call with the same key; you will get the draft it started.",
  );
}
