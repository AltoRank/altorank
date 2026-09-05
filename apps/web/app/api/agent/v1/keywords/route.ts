import { withAgent } from "@/lib/agent/http";
import { fail, ok } from "@/lib/agent/envelope";
import { listKeywords, plannedDatesFor, workspaceInAgency } from "@/lib/agent/data";
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
  const [rows, planned] = await Promise.all([
    listKeywords(ctx.supabase, workspace.id, { status, limit }),
    plannedDatesFor(ctx.supabase, workspace.id),
  ]);
  const keywords = rows.map((k) => toAgentKeyword(k, planned.get(k.id) ?? null));

  const draftable = keywords.filter((k) => k.allowed_mutations.generate_draft.allowed).length;
  const onPlan = keywords.filter((k) => k.planned_for).length;
  return ok(
    { workspace_id: workspace.id, keywords, count: keywords.length, limit },
    keywords.length
      ? `${draftable} of ${keywords.length} keywords can take a new draft; ${onPlan} are on the plan with a planned_for day (see allowed_mutations for reschedule/remove_from_plan). Difficulty null means unmeasured, not easy. GET /keywords/export?format=csv for a file.`
      : "No keywords tracked yet. POST /keywords/suggest finds candidates; confirm the spend with the human first.",
  );
});
