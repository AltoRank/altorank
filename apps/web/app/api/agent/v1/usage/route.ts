import { withAgent } from "@/lib/agent/http";
import { ok } from "@/lib/agent/envelope";
import { agencyWorkspaces, articlesThisMonth } from "@/lib/agent/data";
import { getQuota } from "@/lib/billing/quota";

/**
 * GET /api/agent/v1/usage
 *
 * This month's drafting quota and where it went. `limit: null` means
 * unmetered (self-hosted or operator), not zero.
 */
export const GET = withAgent(async (_request, ctx) => {
  const workspaces = await agencyWorkspaces(ctx);
  const [quota, perWorkspace] = await Promise.all([
    getQuota(ctx.supabase, ctx.agencyId, null),
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
        ? "The free draft is used. Generating needs a plan; ask the human before doing anything else."
        : "The included volume is used. Further drafts bill as overage; ask the human before passing allow_overage: true.";
  } else {
    guidance = `${quota.remaining} of ${quota.limit} included drafts remain this month. Say so before you spend several.`;
  }

  return ok(data, guidance, {
    _meta: { writeable_fields: [], hidden_from_human_summary_fields: ["articles_this_month_by_workspace[].workspace_id", "rate_limit"] },
  });
});
