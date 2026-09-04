import { withAgent } from "@/lib/agent/http";
import { fail, ok } from "@/lib/agent/envelope";
import { listKeywords, workspaceInAgency } from "@/lib/agent/data";
import { toAgentKeyword } from "@/lib/agent/records";

const MAX_LIMIT = 500;

/** GET /api/agent/v1/keywords?workspace_id=&status=&limit= */
export const GET = withAgent(async (request, ctx) => {
  const q = request.nextUrl.searchParams;
  const workspaceId = q.get("workspace_id");
  if (!workspaceId) {
    return fail("invalid_request", "workspace_id is required.", "Pass ?workspace_id= from GET /workspaces.");
  }
  const workspace = await workspaceInAgency(ctx, workspaceId);
  if (!workspace) {
    return fail("not_found", "Workspace not found in this account.", "Call GET /workspaces and use an id from that list.");
  }

  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(q.get("limit")) || 100));
  const status = q.get("status") ?? undefined;
  const keywords = (await listKeywords(ctx.supabase, workspace.id, { status, limit })).map(toAgentKeyword);

  const draftable = keywords.filter((k) => k.allowed_mutations.generate_draft.allowed).length;
  return ok(
    { workspace_id: workspace.id, keywords, count: keywords.length, limit },
    keywords.length
      ? `${draftable} of ${keywords.length} keywords can take a new draft (see allowed_mutations). Difficulty null means unmeasured, not easy.`
      : "No keywords tracked yet. POST /keywords/suggest finds candidates; confirm the spend with the human first.",
  );
});
