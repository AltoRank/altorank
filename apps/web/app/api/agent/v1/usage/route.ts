import { withAgent } from "@/lib/agent/http";
import { ok } from "@/lib/agent/envelope";
import { accountWorkspaces, articlesThisMonth } from "@/lib/agent/data";
import { freeAllowanceUsedMessage, getQuota } from "@/lib/billing/quota";
import { usageGuidance } from "@/lib/agent/usage-guidance";

/**
 * GET /api/agent/v1/usage
 *
 * The drafting quota and where this month's drafts went. On a plan the
 * quota is this month's included volume; before one it is the account's
 * one-time free drafts, which never reset (migration 083). `limit: null`
 * means unmetered (self-hosted or operator), not zero.
 */
export const GET = withAgent(async (_request, ctx) => {
  const workspaces = await accountWorkspaces(ctx);
  const [quota, perWorkspace] = await Promise.all([
    getQuota(ctx.supabase, ctx.accountId, null),
    articlesThisMonth(ctx.supabase, workspaces.map((w) => w.id)),
  ]);

  const data = {
    period: new Date().toISOString().slice(0, 7),
    quota: { limit: quota.limit, used: quota.used, remaining: quota.remaining, plan: quota.plan, reason: quota.reason },
    articles_this_month_by_workspace: workspaces.map((w) => ({
      workspace_id: w.id,
      name: w.name,
      articles: perWorkspace[w.id] ?? 0,
    })),
    rate_limit: { limit: ctx.rate.limit, remaining: ctx.rate.remaining, reset_at: ctx.rate.resetAt },
  };

  let guidance: string;
  if (quota.limit === null) {
    guidance = "Drafting is unmetered on this account. Still ask before generating in bulk; each draft costs model and research credits.";
  } else if ((quota.remaining ?? 0) <= 0) {
    guidance =
      quota.reason === "no-plan"
        ? `${freeAllowanceUsedMessage(quota.limit ?? undefined)} They are a one-time allowance and do not reset. Generating needs a plan; ask the human before doing anything else.`
        : "The included volume is used. Further drafts bill as overage; ask the human before passing allow_overage: true.";
  } else {
    guidance = usageGuidance(quota);
  }

  return ok(data, guidance, {
    _meta: { writeable_fields: [], hidden_from_human_summary_fields: ["articles_this_month_by_workspace[].workspace_id", "rate_limit"] },
  });
});
