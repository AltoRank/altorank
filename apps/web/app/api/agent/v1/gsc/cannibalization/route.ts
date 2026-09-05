import { withAgent } from "@/lib/agent/http";
import { ok } from "@/lib/agent/envelope";
import { gscRows, gscScope, NOT_SYNCED_GUIDANCE, syncBlock } from "@/lib/agent/gsc";
import { cannibalization, windowMeasured, windows } from "@/lib/gsc/analysis";

/**
 * GET /api/agent/v1/gsc/cannibalization?workspace_id=&days=28&min_impressions=10&limit=10
 *
 * Queries where two or more of the site's pages rank, with the page Google
 * already prefers and a suggestion in words per loser. Same computation as
 * the dashboard card; merging or rewriting stays a person's decision.
 */
export const GET = withAgent(async (request, ctx) => {
  const q = request.nextUrl.searchParams;
  const resolved = await gscScope(ctx, q.get("workspace_id"), q.get("days"));
  if ("envelope" in resolved) return resolved.envelope;
  const { scope } = resolved;

  const minImpressions = Math.max(1, Number(q.get("min_impressions")) || 10);
  const limit = Math.min(50, Math.max(1, Number(q.get("limit")) || 10));

  const rows = await gscRows(ctx, scope);
  const measured = windowMeasured(rows, windows(scope.today, scope.days).current);
  const issues = cannibalization(rows, scope.today, scope.days, { minImpressions, limit });

  const data = {
    workspace_id: scope.workspace.id,
    days: scope.days,
    sync: syncBlock(scope.health),
    has_data: measured,
    min_impressions: minImpressions,
    issues,
    count: issues.length,
  };

  if (!measured) return ok(data, NOT_SYNCED_GUIDANCE);
  return ok(
    data,
    issues.length
      ? `${issues.length} quer${issues.length === 1 ? "y" : "ies"} where several pages compete. Each issue names the winner and a suggestion per loser (merge or differentiate). Relay the suggestion text; the change itself is the human's call in the editor.`
      : `No cannibalisation found over ${scope.days} days at ${minImpressions}+ impressions. Say so; do not lower min_impressions to manufacture findings.`,
  );
});
