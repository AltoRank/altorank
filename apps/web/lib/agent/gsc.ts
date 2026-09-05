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

import { WINDOW_DAYS, type GscRow } from "@/lib/gsc/analysis";
import { loadGscRowsFrom, syncHealthFrom, type SyncHealth } from "@/lib/gsc/queries";
import type { Workspace } from "@/lib/types";
import type { AgentContext } from "./auth";
import { workspaceInAgency } from "./data";
import { fail, type FailEnvelope } from "./envelope";

export const GSC_MIN_DAYS = 7;
export const GSC_MAX_DAYS = 90;

export type GscScope = {
  workspace: Workspace;
  health: SyncHealth;
  days: number;
  today: Date;
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
  const workspace = await workspaceInAgency(ctx, workspaceId);
  if (!workspace) {
    return { envelope: fail("not_found", "Workspace not found in this account.", "Call GET /workspaces and use an id from that list.") };
  }
  const health = await syncHealthFrom(ctx.supabase, workspace.id);
  if (!health.connected) {
    return { envelope: fail("not_available", "Search Console is not connected for this workspace.", NOT_CONNECTED_GUIDANCE) };
  }
  return { scope: { workspace, health, days: daysParam(daysRaw), today } };
}

export async function gscRows(ctx: AgentContext, scope: GscScope): Promise<GscRow[]> {
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
  };
}

/** Connected but nothing synced yet: a real state with its own sentence. */
export const NOT_SYNCED_GUIDANCE =
  "Search Console is connected but no data has been synced yet; the nightly sync fills it in. " +
  "Say the connection is new and the numbers are not in yet. Do not report zero.";
