import { withAgent } from "@/lib/agent/http";
import { ok } from "@/lib/agent/envelope";
import { gscRows, gscScope, notSyncedGuidance, staleNote, syncBlock } from "@/lib/agent/gsc";
import { queryMovers, searchPerformance, windows } from "@/lib/gsc/analysis";
import { coverageOf } from "@/lib/gsc/queries";

/**
 * GET /api/agent/v1/gsc/queries?workspace_id=&days=28&limit=25
 *
 * Every query, this window against the one before: the "what moved?" view a
 * weekly SEO check starts from. Gainers, losers, new and lost queries, each
 * with clicks, impressions and position in both windows. Stored rows only.
 */
export const GET = withAgent(async (request, ctx) => {
  const q = request.nextUrl.searchParams;
  const resolved = await gscScope(ctx, q.get("workspace_id"), q.get("days"));
  if ("envelope" in resolved) return resolved.envelope;
  const { scope } = resolved;
  const limit = Math.min(100, Math.max(1, Number(q.get("limit")) || 25));

  const gsc = await gscRows(ctx, scope);
  const coverage = coverageOf(scope.health);
  const performance = searchPerformance(gsc, scope.today, scope.days, coverage);
  const moves = queryMovers(gsc, scope.today, scope.days);
  const w = windows(scope.today, scope.days);

  const data = {
    workspace_id: scope.workspace.id,
    days: scope.days,
    sync: syncBlock(scope.health),
    window: { current: w.current, previous: w.previous },
    comparable: performance.comparable,
    queries_seen: moves.length,
    gainers: moves.filter((m) => m.previous && m.impressionsChange > 0).slice(0, limit),
    losers: moves.filter((m) => m.current.impressions > 0 && m.impressionsChange < 0).slice(0, limit),
    new: moves.filter((m) => !m.previous && m.current.impressions > 0).slice(0, limit),
    lost: moves.filter((m) => m.previous && m.current.impressions === 0).slice(0, limit),
  };

  if (!performance.hasData || !performance.currentMeasured) {
    return ok(data, notSyncedGuidance(scope.health, scope.now) + staleNote(scope.health));
  }
  return ok(
    data,
    `${moves.length} queries across the two ${scope.days}-day windows. ` +
      (performance.comparable ? "" : "The windows are not both wholly synced, so changes are partial: say so. ") +
      "positionChange is positive when the query moved up. Nothing here filters bot or rank-tracker traffic: a query that jumps on one day and vanishes is often a tracker, not demand. " +
      "Never present these as anything but Google's own numbers." +
      staleNote(scope.health),
  );
});
