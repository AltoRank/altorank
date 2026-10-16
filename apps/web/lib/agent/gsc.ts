// ---------------------------------------------------------------------------
// Search Console reads for the agent API
// ---------------------------------------------------------------------------
//
// The four GSC endpoints share one preamble: resolve the workspace, check
// that Search Console is connected, load the stored rows. It lives here so
// the refusal is identical everywhere and so "not connected" can never be
// mistaken for "no traffic": a workspace without a connection gets an
// ok:false envelope, never an empty list a model would read as zero clicks.
//
// Everything served is what the nightly sync already stored and the dashboard
// already renders (lib/gsc/analysis.ts). Nothing here calls Google.

import { touchesWindow, windowAnchor, windowMeasured, WINDOW_DAYS, type DateWindow, type GscShapes, type GscRow } from "@/lib/gsc/analysis";
import { coverageOf, loadGscRowsFrom, syncHealthFrom, type DashboardGscRows, type SyncHealth } from "@/lib/gsc/queries";
import type { Workspace } from "@/lib/types";
import type { AgentContext } from "./auth";
import { workspaceInAccount } from "./data";
import { fail, type FailEnvelope } from "./envelope";

export const GSC_MIN_DAYS = 7;
export const GSC_MAX_DAYS = 90;

export type GscScope = {
  workspace: Workspace;
  health: SyncHealth;
  days: number;
  /**
   * The day the windows end before: the day after the newest synced day when
   * that is recent (analysis.ts `windowAnchor`), so both windows hold the same
   * number of days Google has published.
   */
  today: Date;
  /** The real clock, for anything about the connection rather than the data. */
  now: Date;
};

export const NOT_CONNECTED_GUIDANCE =
  "Search Console is not connected for this workspace, so there is no traffic data - not zero traffic, no data. " +
  "Ask the human to connect Google Search Console on the workspace's Integrations page; you cannot connect it from here. " +
  "Do not report clicks, impressions or positions for this site.";

/** Parse ?days= within the window the stored data covers; default the dashboard's 28. */
export function daysParam(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return WINDOW_DAYS;
  return Math.min(GSC_MAX_DAYS, Math.max(GSC_MIN_DAYS, Math.round(n)));
}

/**
 * The workspace and its Search Console connection, or the envelope that says
 * why not. `workspace_id` is required: Search Console data is per property,
 * and a sum across an account's sites would describe none of them.
 */
export async function gscScope(
  ctx: AgentContext,
  workspaceId: string | null,
  daysRaw: string | null,
  today: Date = new Date(),
): Promise<{ scope: GscScope } | { envelope: FailEnvelope }> {
  if (!workspaceId) {
    return { envelope: fail("invalid_request", "workspace_id is required.", "Pass ?workspace_id= from GET /workspaces.") };
  }
  const workspace = await workspaceInAccount(ctx, workspaceId);
  if (!workspace) {
    return { envelope: fail("not_found", "Workspace not found in this account.", "Call GET /workspaces and use an id from that list.") };
  }
  const health = await syncHealthFrom(ctx.supabase, workspace.id);
  if (!health.connected) {
    return { envelope: fail("not_available", "Search Console is not connected for this workspace.", NOT_CONNECTED_GUIDANCE) };
  }
  const blocked = connectionProblem(health);
  if (blocked) return { envelope: blocked };
  return { scope: { workspace, health, days: daysParam(daysRaw), today: windowAnchor(today, coverageOf(health).through), now: today } };
}

/**
 * The two connected states in which there is nothing to report, as their own
 * refusals: a token Google refused, and a connection whose every sync has
 * failed (most often: the Google account has no Search Console property for
 * the domain). Both used to come back as ok:true with "the connection is new,
 * the nightly sync fills it in", which neither of them will.
 */
export function connectionProblem(health: SyncHealth): FailEnvelope | null {
  if (health.needsReconnect) {
    return fail("not_available", "Google refused the stored Search Console token for this workspace; syncing has stopped.", NEEDS_RECONNECT_GUIDANCE);
  }
  if (health.lastSyncError && !everSynced(health)) {
    return fail("not_available", "Search Console is connected, but no sync has succeeded yet.", syncFailingGuidance(health.lastSyncError));
  }
  return null;
}

/** Any sync of this site has completed: a recorded outcome or a stored row. */
function everSynced(health: SyncHealth): boolean {
  return Boolean(health.lastSyncAt || health.latestMetricDate || health.syncedThrough);
}

/** The stored rows for the scope's windows, partitioned by shape (lib/gsc/read.ts). */
export async function gscRows(ctx: AgentContext, scope: GscScope): Promise<DashboardGscRows> {
  return loadGscRowsFrom(ctx.supabase, scope.workspace.id, scope.today, scope.days);
}

/** What every GSC response says about its own freshness. */
export function syncBlock(health: SyncHealth) {
  return {
    connected: health.connected,
    connected_at: health.connectedAt,
    site_url: health.siteUrl,
    last_sync_at: health.lastSyncAt,
    latest_metric_date: health.latestMetricDate,
    // The days the sync has an answer for, including days Google reported as
    // empty. Null until the sync has recorded one.
    synced_from: health.syncedFrom,
    synced_through: health.syncedThrough,
    // True when Google refused the stored token: the numbers below stop at
    // last_sync_at and will not move until a person reconnects in Settings.
    needs_reconnect: health.needsReconnect,
    last_sync_error: health.lastSyncError,
  };
}

export const NEEDS_RECONNECT_GUIDANCE =
  "Google refused the stored token for this site's Search Console connection, so the nightly sync has stopped and the stored numbers are out of date. " +
  "Ask the human to reconnect Google on the workspace's Integrations page; you cannot do it from here. " +
  "Do not report clicks, impressions, positions or trends for this site until then.";

export function syncFailingGuidance(error: string): string {
  return (
    "Search Console is connected, but every sync so far has failed, so there is no data - not zero traffic, no data. " +
    `The last sync said: "${error.slice(0, 300)}". Relay that to the human: when it says the Google account has no Search Console property for the domain, ` +
    "the fix is to add the property in Search Console or reconnect with the account that owns it, on the workspace's Integrations page. " +
    "Do not report clicks, impressions or positions for this site."
  );
}

/** Connected but nothing synced yet: a real state with its own sentence. */
export const NOT_SYNCED_GUIDANCE =
  "Search Console is connected but no data has been synced yet; the nightly sync fills it in. " +
  "Say the connection is new and the numbers are not in yet. Do not report zero.";

/** How long "the connection is new" stays true: the backfill and two nightly runs. */
export const NEW_CONNECTION_DAYS = 3;

/**
 * Nothing synced for the window, in the words that fit the connection's age.
 * A connection made today gets "new, the numbers are not in yet"; one made a
 * month ago with nothing to show is not new, and saying so would hide a
 * connection that is not working.
 */
export function notSyncedGuidance(health: SyncHealth, today: Date = new Date()): string {
  const connected = health.connectedAt ? Date.parse(health.connectedAt) : NaN;
  if (!Number.isFinite(connected) || today.getTime() - connected < NEW_CONNECTION_DAYS * 86_400_000) return NOT_SYNCED_GUIDANCE;
  return (
    `Search Console has been connected since ${health.connectedAt!.slice(0, 10)}, but no sync has stored anything for this window. ` +
    "That is missing data, not zero: do not report zero. Tell the human the numbers are missing and that the Search Console connection on the workspace's Integrations page should be checked."
  );
}

/**
 * Whether the window was measured: rows in it, or a recorded sync answer for
 * some day in it (migration 115). The second is what turns a site Google
 * reported as empty into a measured zero instead of "not synced yet" forever.
 */
export function measuredIn(scope: GscScope, gsc: Partial<GscShapes<Pick<GscRow, "metric_date">>>, w: DateWindow): boolean {
  return windowMeasured(gsc, w) || touchesWindow({ from: scope.health.syncedFrom, through: scope.health.syncedThrough }, w);
}

/** Said beside numbers when the newest sync failed but earlier ones stored data. */
export function staleNote(health: SyncHealth): string {
  return health.lastSyncError
    ? ` The most recent sync failed (last_sync_error); the numbers run to ${health.latestMetricDate ?? "the last synced day"} and may be behind.`
    : "";
}
