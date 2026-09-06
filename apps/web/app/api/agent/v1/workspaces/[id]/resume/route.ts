import { withAgent, appBaseUrl } from "@/lib/agent/http";
import { fail, ok } from "@/lib/agent/envelope";
import { workspaceInAgency } from "@/lib/agent/data";
import { toAgentWorkspace } from "@/lib/agent/records";
import { resumeWorkspace } from "@/lib/workspaces/pause";

// The re-plan can call the recommendation model.
export const maxDuration = 60;

/**
 * POST /api/agent/v1/workspaces/{id}/resume
 *
 * Put a paused site back to the status it had and re-plan its calendar from
 * today. Same core as the dashboard's Resume (lib/workspaces/pause.ts). A
 * site paused from Billing (`paused_until` set) is not resumed here; that is
 * the account's pause and is the human's on the Billing page.
 */
export const POST = withAgent<{ id: string }>(async (request, ctx, { id }) => {
  const workspace = await workspaceInAgency(ctx, id);
  if (!workspace) return fail("not_found", "Workspace not found in this account.", "Call GET /workspaces and use an id from that list.");
  if (workspace.status === "paused" && workspace.paused_until) {
    return fail(
      "not_available",
      "This site is paused by the account-wide pause on Billing, not by hand.",
      "Only a human can lift the billing pause, on the Billing page. Do not try to change the site's status another way.",
    );
  }

  const { changed, status, replanned } = await resumeWorkspace(ctx.supabase, ctx.agencyId, workspace.id);
  const after = await workspaceInAgency(ctx, workspace.id);
  return ok(
    { workspace: after ? toAgentWorkspace(after, appBaseUrl(request)) : null, changed, status, replanned },
    !changed
      ? `"${workspace.name}" was not paused; nothing changed.`
      : replanned === null
        ? `"${workspace.name}" resumed. The calendar could not be re-planned just now; the nightly run fills it in. Nothing published.`
        : `"${workspace.name}" resumed with ${replanned} keyword${replanned === 1 ? "" : "s"} planned from today. Nothing published.`,
  );
}, { scope: "write", mutation: true });
