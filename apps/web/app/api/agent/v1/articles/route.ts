import { withAgent, appBaseUrl } from "@/lib/agent/http";
import { fail, ok } from "@/lib/agent/envelope";
import { listArticles, workspaceInAgency } from "@/lib/agent/data";
import { toAgentArticle } from "@/lib/agent/records";

const MAX_LIMIT = 200;

/** GET /api/agent/v1/articles?workspace_id=&status=&limit= */
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

  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(q.get("limit")) || 50));
  const status = q.get("status") ?? undefined;
  const base = appBaseUrl(request);
  const articles = (await listArticles(ctx.supabase, workspace.id, { status, limit })).map((a) =>
    toAgentArticle(a, base),
  );

  const awaiting = articles.filter((a) => a.status === "review").length;
  return ok(
    { workspace_id: workspace.id, articles, count: articles.length, limit },
    awaiting
      ? `${awaiting} article(s) are awaiting human review. Point the person at editor_url; do not generate a replacement for something they have not read yet.`
      : "Nothing is waiting for review. allowed_mutations on each article says what you may do next.",
  );
});
