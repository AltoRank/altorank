import { withAgent, appBaseUrl } from "@/lib/agent/http";
import { ok } from "@/lib/agent/envelope";
import { agencyWorkspaces } from "@/lib/agent/data";
import { toAgentWorkspace } from "@/lib/agent/records";
import { getQuota } from "@/lib/billing/quota";

/**
 * GET /api/agent/v1/auth/whoami
 *
 * The preflight call: which account this key opens, which sites are in it,
 * and how much drafting room is left this month. An agent should run this
 * before anything else and pick a workspace from the answer.
 */
export const GET = withAgent(async (request, ctx) => {
  const base = appBaseUrl(request);
  const [{ data: agency }, workspaces, quota] = await Promise.all([
    ctx.supabase.from("agencies").select("id, name, plan").eq("id", ctx.agencyId).single(),
    agencyWorkspaces(ctx),
    // null caller: an API key is nobody's session. Same contract as the crons.
    getQuota(ctx.supabase, ctx.agencyId, null),
  ]);

  const data = {
    key: ctx.key,
    account: agency ? { id: agency.id, name: agency.name, plan: agency.plan } : null,
    workspaces: workspaces.map((w) => toAgentWorkspace(w, base)),
    quota: {
      limit: quota.limit,
      used: quota.used,
      remaining: quota.remaining,
      plan: quota.plan,
      reason: quota.reason,
    },
    rate_limit: { limit: ctx.rate.limit, remaining: ctx.rate.remaining, reset_at: ctx.rate.resetAt },
  };

  const guidance =
    workspaces.length === 0
      ? "This account has no workspaces yet. Ask the human to add a site in the dashboard before continuing."
      : workspaces.length === 1
        ? `One workspace: "${workspaces[0].name}". Use its id for every workspace_id parameter. Check GET /readiness and GET /workspaces/{id} before generating.`
        : `${workspaces.length} workspaces. Ask the human which site they mean unless it is obvious, then use that workspace_id everywhere.`;

  return ok(data, guidance, {
    _meta: {
      writeable_fields: [],
      hidden_from_human_summary_fields: ["key.id", "account.id", "workspaces[].id", "rate_limit"],
    },
  });
});
