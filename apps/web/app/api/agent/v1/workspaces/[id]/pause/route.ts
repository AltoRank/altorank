import { withAgent, appBaseUrl } from "@/lib/agent/http";
import { fail, ok } from "@/lib/agent/envelope";
import { workspaceInAgency } from "@/lib/agent/data";
import { toAgentWorkspace } from "@/lib/agent/records";
import { pauseWorkspace } from "@/lib/workspaces/pause";

/**
 * POST /api/agent/v1/workspaces/{id}/pause
 *
 * Stop AltoRank writing or publishing for one site until Resume. Same core
 * as the dashboard's Pause button (lib/workspaces/pause.ts): status goes to
 * paused with `paused_meta` recording since when and what it was before;
 * drafts, plan and pace are left exactly as they are. Every cron skips a
 * paused site. This is not the account-wide billing pause.
 */
export const POST = withAgent<{ id: string }>(async (request, ctx, { id }) => {
  const workspace = await workspaceInAgency(ctx, id);
  if (!workspace) return fail("not_found", "Workspace not found in this account.", "Call GET /workspaces and use an id from that list.");

  // `by` is a user id in the dashboard; an API key is nobody, so null. The
  // key's name is returned so the agent can say who did it.
  const { changed, meta } = await pauseWorkspace(ctx.supabase, ctx.agencyId, workspace.id, null);
  const after = await workspaceInAgency(ctx, workspace.id);
  return ok(
    {
      workspace: after ? toAgentWorkspace(after, appBaseUrl(request)) : null,
      changed,
      paused_meta: meta,
      paused_by_key: changed ? ctx.key.name : null,
    },
    changed
      ? `"${workspace.name}" is paused: no drafts written, nothing published, until resumed. Drafts in review, the plan and the pace are untouched. Resume with POST /workspaces/{id}/resume.`
      : `"${workspace.name}" was already paused (since ${meta?.since ?? "unknown"}); nothing changed.`,
  );
}, { scope: "write", mutation: true });
