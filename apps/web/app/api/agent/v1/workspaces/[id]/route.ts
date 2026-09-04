import { withAgent, appBaseUrl } from "@/lib/agent/http";
import { fail, ok } from "@/lib/agent/envelope";
import { integrationStatus, workspaceInAgency } from "@/lib/agent/data";
import { toAgentWorkspace, workspaceHuman } from "@/lib/agent/records";

/**
 * GET /api/agent/v1/workspaces/{id}
 *
 * One site with its integration status, plus a `_human` block so the agent
 * can describe the setup to a person without reading column names aloud.
 */
export const GET = withAgent<{ id: string }>(async (request, ctx, { id }) => {
  const workspace = await workspaceInAgency(ctx, id);
  if (!workspace) {
    return fail(
      "not_found",
      "Workspace not found in this account.",
      "Call GET /workspaces and use an id from that list.",
    );
  }

  const integrations = await integrationStatus(ctx.supabase, workspace.id);
  const record = toAgentWorkspace(workspace, appBaseUrl(request));
  const cms = integrations.filter((i) => i.tag === "CMS" && i.connected).map((i) => i.name);

  return ok(
    { workspace: record, integrations },
    cms.length
      ? `Publishing goes through ${cms.join(", ")}, by a human. Drafts you generate wait in the review queue.`
      : "No CMS is connected, so a human will publish drafts by hand. Mention this if they ask about publishing.",
    {
      _human: workspaceHuman(record, integrations),
      _meta: {
        writeable_fields: [],
        hidden_from_human_summary_fields: ["workspace.id", "workspace.location_code", "workspace.dashboard_url"],
      },
    },
  );
});
