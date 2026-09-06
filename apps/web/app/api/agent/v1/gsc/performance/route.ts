import { withAgent } from "@/lib/agent/http";
import { ok } from "@/lib/agent/envelope";
import { gscRows, gscScope, NOT_SYNCED_GUIDANCE, syncBlock } from "@/lib/agent/gsc";
import { queryOpportunities, searchPerformance, topPages } from "@/lib/gsc/analysis";

/**
 * GET /api/agent/v1/gsc/performance?workspace_id=&days=28
 *
 * The dashboard's Search Console block as data: clicks and impressions for
 * the window against the window before, the daily series, top pages and
 * queries one push from page one. Stored rows only; nothing calls Google.
 */
export const GET = withAgent(async (request, ctx) => {
  const q = request.nextUrl.searchParams;
  const resolved = await gscScope(ctx, q.get("workspace_id"), q.get("days"));
  if ("envelope" in resolved) return resolved.envelope;
  const { scope } = resolved;

  const rows = await gscRows(ctx, scope);
  const performance = searchPerformance(rows, scope.today, scope.days);
  const pages = topPages(rows, scope.today, scope.days, 10);
  const opportunities = queryOpportunities(rows, scope.today, scope.days, 10);

  const data = {
    workspace_id: scope.workspace.id,
    days: scope.days,
    sync: syncBlock(scope.health),
    has_data: performance.hasData,
    previous_window_measured: performance.previousMeasured,
    clicks: performance.clicks,
    impressions: performance.impressions,
    series: { current: performance.current, previous: performance.previous },
    top_pages: pages,
    opportunities,
  };

  if (!performance.hasData) return ok(data, NOT_SYNCED_GUIDANCE);
  const delta = performance.clicks.changePct;
  const trend = delta === null ? "no previous window to compare against" : `${delta >= 0 ? "+" : ""}${delta}% vs the ${scope.days} days before`;
  return ok(
    data,
    `${performance.clicks.current} clicks and ${performance.impressions.current} impressions over ${scope.days} days (${trend}). ` +
      `opportunities are queries in positions 4-15 with impressions: the next revision is worth more than a new article there. ` +
      `A null changePct means no baseline, not no change. Never present these as anything but Google's own numbers.`,
  );
});
