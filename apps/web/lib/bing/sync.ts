// Bing sync for one workspace: the daily series, replaced in place.
//
// Shared by the connect action (which pulls the whole window so the dashboard
// has a line the moment the key is pasted) and the nightly cron (which pulls
// the last week, because Bing revises recent days).

import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt } from "@/lib/crypto";
import { fetchBingDailyTraffic, listBingSites, matchBingSite, type BingDaily } from "./webmaster";

export type BingIntegration = {
  id: string;
  tokens: { encrypted?: string } | null;
  config: { bingSiteUrl?: string } | null;
  workspace: { id: string; domain: string | null } | null;
};

export type BingSyncResult = { workspaceId: string; rows: number; from: string | null; error?: string };

/** The stored credential: `{ apiKey }`, encrypted the way Google tokens are. */
export function readBingKey(encrypted: string): string {
  const parsed = JSON.parse(decrypt(encrypted)) as { apiKey?: unknown };
  if (typeof parsed.apiKey !== "string" || !parsed.apiKey) throw new Error("stored Bing credential has no apiKey");
  return parsed.apiKey;
}

/** ISO date `days` back from today, UTC. */
export function sinceDate(days: number, now = new Date()): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Rows for analytics_metrics: one per day, query and page_url null, because
 * that is the only granularity Bing reports daily. Days before `since` are
 * dropped so a six-month history does not land on every nightly run.
 */
export function rowsFromBingDaily(workspaceId: string, daily: BingDaily[], since: string) {
  return daily
    .filter((d) => d.date >= since)
    .map((d) => ({
      workspace_id: workspaceId,
      source: "bing" as const,
      metric_date: d.date,
      clicks: d.clicks,
      impressions: d.impressions,
      ctr: d.impressions > 0 ? Math.round((d.clicks / d.impressions) * 10000) / 10000 : 0,
    }));
}

export async function syncBingWorkspace(
  supabase: SupabaseClient,
  integration: BingIntegration,
  days: number,
): Promise<BingSyncResult> {
  const ws = integration.workspace;
  if (!ws) return { workspaceId: "", rows: 0, from: null, error: "no workspace" };
  const encrypted = integration.tokens?.encrypted;
  if (!encrypted) return { workspaceId: ws.id, rows: 0, from: null, error: "no credential" };

  try {
    const apiKey = readBingKey(encrypted);

    // Resolved once and stored, like the Search Console property: the account
    // may have verified https://www.example.com/ or http://example.com, and
    // Bing wants the exact string it has on file.
    let siteUrl = integration.config?.bingSiteUrl;
    if (!siteUrl) {
      if (!ws.domain) throw new Error("the workspace has no domain to match a Bing site against");
      const sites = await listBingSites(apiKey);
      const match = matchBingSite(sites, ws.domain);
      if (!match) {
        const verified = sites.filter((s) => s.isVerified).map((s) => s.url).slice(0, 5).join(", ") || "none";
        throw new Error(
          `This Bing account has no verified site for ${ws.domain}. Verified: ${verified}. Add and verify it in Bing Webmaster Tools, or import your Search Console sites there.`,
        );
      }
      siteUrl = match.url;
      await supabase
        .from("workspace_integrations")
        .update({ config: { ...(integration.config ?? {}), bingSiteUrl: siteUrl } })
        .eq("id", integration.id);
    }

    const since = sinceDate(days);
    const rows = rowsFromBingDaily(ws.id, await fetchBingDailyTraffic(apiKey, siteUrl), since);

    // Replace the window rather than append to it: Bing revises recent days,
    // and the connect-time pull overlaps every following nightly run.
    await supabase
      .from("analytics_metrics")
      .delete()
      .eq("workspace_id", ws.id)
      .eq("source", "bing")
      .gte("metric_date", since);
    if (rows.length) {
      const { error } = await supabase.from("analytics_metrics").insert(rows);
      if (error) throw new Error(error.message);
    }
    return { workspaceId: ws.id, rows: rows.length, from: since };
  } catch (err) {
    return { workspaceId: ws.id, rows: 0, from: null, error: err instanceof Error ? err.message : "Unknown error" };
  }
}
