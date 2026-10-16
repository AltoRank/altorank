import { withAgent } from "@/lib/agent/http";
import { ok } from "@/lib/agent/envelope";
import { gscRows, gscScope, notSyncedGuidance, staleNote, syncBlock } from "@/lib/agent/gsc";
import { queryOpportunities, searchPerformance, topPages, windows } from "@/lib/gsc/analysis";
import { coverageOf } from "@/lib/gsc/queries";

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

  const gsc = await gscRows(ctx, scope);
  const coverage = coverageOf(scope.health);
  const performance = searchPerformance(gsc, scope.today, scope.days, coverage);
  const pages = topPages(gsc, scope.today, scope.days, 10, coverage);
  const opportunities = queryOpportunities(gsc, scope.today, scope.days, 10);
  const w = windows(scope.today, scope.days);
  // Rows, or a sync that answered for a window with none: a measured zero.
  const hasData = performance.hasData;

  const data = {
    workspace_id: scope.workspace.id,
    days: scope.days,
    sync: syncBlock(scope.health),
    has_data: hasData,
    // The two windows, ending on the newest day Google has published.
    window: { current: w.current, previous: w.previous },
    previous_window_measured: performance.previousMeasured,
    // Both windows wholly synced: only then is a changePct stated.
    comparable: performance.comparable,
    clicks: performance.clicks,
    impressions: performance.impressions,
    series: { current: performance.current, previous: performance.previous },
    top_pages: pages,
    opportunities,
  };

  if (!hasData) return ok(data, notSyncedGuidance(scope.health, scope.now));
  if (performance.impressions.current === 0) {
    return ok(
      data,
      `Search Console reports no impressions for this site over the last ${scope.days} days. That is Google's measured zero, not missing data: say the site is not being shown in Google search yet.` +
        staleNote(scope.health),
    );
  }
  const delta = performance.clicks.changePct;
  const trend =
    delta !== null
      ? `${delta >= 0 ? "+" : ""}${delta}% vs the ${scope.days} days before`
      : !performance.previousMeasured
        ? `no previous window to compare against: synced history starts ${coverage.from ?? "within this window"}, so the ${scope.days} days before are not whole`
        : !performance.currentComplete
          ? "no comparison: the newest days of this window are not synced yet"
          : "no comparison: the previous window had no clicks";
  return ok(
    data,
    `${performance.clicks.current} clicks and ${performance.impressions.current} impressions over ${scope.days} days (${trend}). ` +
      `opportunities are queries in positions 4-15 with impressions: the next revision is worth more than a new article there. ` +
      `A null changePct means no baseline, not no change. Never present these as anything but Google's own numbers.` +
      staleNote(scope.health),
  );
});
