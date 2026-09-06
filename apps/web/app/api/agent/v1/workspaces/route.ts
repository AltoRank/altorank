import { withAgent, appBaseUrl } from "@/lib/agent/http";
import { ok } from "@/lib/agent/envelope";
import { agencyWorkspaces } from "@/lib/agent/data";
import { toAgentWorkspace } from "@/lib/agent/records";

/** GET /api/agent/v1/workspaces - every site in the account. */
export const GET = withAgent(async (request, ctx) => {
  const base = appBaseUrl(request);
  const workspaces = (await agencyWorkspaces(ctx)).map((w) => toAgentWorkspace(w, base));
  return ok(
    { workspaces, count: workspaces.length },
    workspaces.length
      ? "Pick the workspace the human means and pass its id as workspace_id. GET /workspaces/{id} shows its integrations."
      : "No workspaces. Ask the human to add a site in the dashboard first.",
  );
});
